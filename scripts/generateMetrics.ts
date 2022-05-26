import { Buffer } from "buffer";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { Octokit, RestEndpointMethodTypes } from "@octokit/rest";
import minimist from "minimist";
import { DateTime } from "luxon";
import percentile from "percentile";
import mean from "lodash.mean";
import { Remarkable } from "remarkable";

type GithubPull =
  RestEndpointMethodTypes["pulls"]["list"]["response"]["data"][0];
type GithubIssue =
  RestEndpointMethodTypes["issues"]["list"]["response"]["data"][0];
type GithubPullOrIssue = GithubPull | GithubIssue;

const REPO_ORG = "backstage";
const REPO_NAME = "tempo";
const METRIC_FILENAME = "metrics.json";
const ADOPTER_MD_URL =
  "https://raw.githubusercontent.com/backstage/backstage/master/ADOPTERS.md";
const PAST_DAYS_FOR_METRICS = 30;

const argv = minimist(process.argv.slice(2));
const commitChanges = "commitChanges" in argv;
const withMetrics = "withMetrics" in argv;
const withAdopterList = "withAdopterList" in argv;

if (!process.env.GITHUB_TOKEN) {
  console.error("GITHUB_TOKEN is not set. Please provide a Github token");
  process.exit(1);
}

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

const iteratorRepos = octokit.paginate.iterator(octokit.rest.repos.listForOrg, {
  org: REPO_ORG,
  per_page: 100,
});

if (!commitChanges) {
  console.log(
    "⚠️  Running in dryrun mode, no metrics will be commited back ⚠️"
  );
}

const isContributorABot = (contributor: string) => {
  const botAccounts = ["snyk-bot"];

  return contributor.endsWith("[bot]") || botAccounts.includes(contributor);
};

const getAdopterList = async () => {
  const adopters = new Set<string>();
  const response = await fetch(ADOPTER_MD_URL);
  const content = await response.text();
  const tokens = new Remarkable().parse(content, {});

  let isInTbody = false;
  let isNextCell = false;

  const isBlockToken = (
    token: Remarkable.BlockContentToken
  ): token is Remarkable.BlockContentToken =>
    token.type === "inline" && Array.isArray(token.children);

  for (const token of tokens) {
    if (token.type === "tbody_open") {
      isInTbody = true;
    } else if (isInTbody && token.type === "tr_open") {
      isNextCell = true;
    } else if (isBlockToken(token) && isNextCell) {
      if (token.content) {
        adopters.add(token.content);
      }

      isNextCell = false;
    }
  }

  return Array.from(adopters);
};

const getCurrentMetricFileSha = async () => {
  const contents = fs.readFileSync(
    path.resolve(__dirname, `../${METRIC_FILENAME}`),
    "utf8"
  );

  const file = (
    await octokit.rest.git.createBlob({
      owner: REPO_ORG,
      repo: REPO_NAME,
      content: Buffer.from(contents).toString("base64"),
      encoding: "base64",
    })
  ).data;
  return file.sha;
};

const main = async () => {
  /**
   * Metric stores.
   */
  const namesOfContributors: Set<string> = new Set();
  const namesOfRecentContributors: Set<string> = new Set();
  const secondsToClosePulls: number[] = [];
  const secondsToCloseIssues: number[] = [];
  const bucketPullCount: Record<string, number> = {};
  const bucketNewContributors: Record<string, Set<string>> = {};

  /**
   * Takes a pull request or issue and returns true/false
   * if it's within the range for metrics.
   */
  const isPullOrIssueWithinMetricsRange = (pullOrIssue: GithubPullOrIssue) => {
    return (
      DateTime.now().diff(DateTime.fromISO(pullOrIssue.created_at), "days")
        .days < PAST_DAYS_FOR_METRICS
    );
  };

  /**
   * Returns a weekly bucket key
   */
  const getBucketKey = (pullOrIssue: GithubPullOrIssue) => {
    const dateTime = DateTime.fromISO(pullOrIssue.created_at);
    return `${dateTime.year}:${dateTime.weekNumber}`;
  };

  /**
   * Adds the first time a contributor is seen to the weekly buckets
   */
  const addNewContributorToBucket = (
    bucketKey: string,
    contributor: string
  ) => {
    bucketNewContributors[bucketKey] =
      bucketNewContributors[bucketKey] || new Set<string>();

    for (const contributors of Object.values(bucketNewContributors)) {
      if (contributors.has(contributor)) {
        return;
      }
    }

    bucketNewContributors[bucketKey].add(contributor);
  };

  /**
   * Takes a pull request or issue and returns the time from
   * when it was opened to when it was closed.
   */
  const getSecondsToClose = (pullOrIssue: GithubPullOrIssue) => {
    if (pullOrIssue.closed_at) {
      const dateCreatedAt = DateTime.fromISO(pullOrIssue.created_at);
      const dateClosedAt = DateTime.fromISO(pullOrIssue.closed_at);
      return dateClosedAt.diff(dateCreatedAt, "seconds").seconds;
    }
  };

  /**
   * Takes a pull request, extract the metrics and stores them.
   */
  const getPullMetrics = (pull: GithubPull) => {
    const key = getBucketKey(pull);
    const secondsToClose = getSecondsToClose(pull);
    const isPullInRange = isPullOrIssueWithinMetricsRange(pull);

    bucketPullCount[key] = bucketPullCount[key] || 0;
    bucketPullCount[key]++;

    if (isPullInRange && secondsToClose) {
      secondsToClosePulls.push(secondsToClose);
    }

    if (pull.user?.login && !isContributorABot(pull.user?.login)) {
      addNewContributorToBucket(key, pull.user.login);

      if (isPullInRange) {
        namesOfRecentContributors.add(pull.user.login);
      } else {
        namesOfContributors.add(pull.user.login);
      }
    }
  };

  /**
   * Takes an pull request, extract the metrics and stores them.
   */
  const getIssueMetrics = (issue: GithubIssue) => {
    const key = getBucketKey(issue);
    const secondsToClose = getSecondsToClose(issue);
    const isIssueInRange = isPullOrIssueWithinMetricsRange(issue);

    if (isIssueInRange && secondsToClose) {
      secondsToCloseIssues.push(secondsToClose);
    }

    if (issue.user?.login && !isContributorABot(issue.user?.login)) {
      addNewContributorToBucket(key, issue.user.login);

      if (isIssueInRange) {
        namesOfRecentContributors.add(issue.user.login);
      } else {
        namesOfContributors.add(issue.user.login);
      }
    }
  };

  if (withMetrics) {
    // For each repo in the backstage org
    for await (const { data: repos } of iteratorRepos) {
      for (const repo of repos) {
        console.log("Processing repo: ", repo.name);

        const iteratorPulls = octokit.paginate.iterator(
          octokit.rest.pulls.list,
          {
            owner: REPO_ORG,
            repo: repo.name,
            per_page: 100,
            sort: "created",
            direction: "asc",
            state: "closed",
          }
        );

        // For each pull request in the repo in the last N days
        for await (const { data: pulls } of iteratorPulls) {
          console.log("Processing pulls: ", pulls.length);

          for (const pull of pulls) {
            getPullMetrics(pull);
          }
        }

        const iteratorIssues = octokit.paginate.iterator(
          octokit.rest.issues.listForRepo,
          {
            owner: REPO_ORG,
            repo: repo.name,
            per_page: 100,
            sort: "created",
            direction: "asc",
            state: "closed",
          }
        );

        // For each issue in the repo in the last N days
        for await (const { data: issues } of iteratorIssues) {
          console.log("Processing issues: ", issues.length);

          for (const issue of issues) {
            if (!("pull_request" in issue)) {
              issueCount++;
              getIssueMetrics(issue);
            }
          }

          if (withSubset) {
            break;
          }
        }
      }
    }
  }

  /**
   * Fetch the latest adopters.
   */
  const adopterList = withAdopterList ? await getAdopterList() : [];

  /**
   * Calculate the final metrics from that in the stores.
   */
  const p50SecondsToClosePulls = percentile(50, secondsToClosePulls);
  const p50SecondsToCloseIssues = percentile(50, secondsToCloseIssues);
  const meanSecondsToClosePulls = mean(secondsToClosePulls);
  const meanSecondsToCloseIssues = mean(secondsToCloseIssues);

  const pullCounts = Object.values(bucketPullCount);
  const contributorCounts = Object.values(bucketNewContributors).map(
    (c) => c.size
  );

  const p50NumberOfNewPullsPerWeek = percentile(50, pullCounts);
  const p50NumberOfNewContributorsPerWeek = percentile(50, contributorCounts);
  const meanNumberOfNewPullsPerWeek = mean(pullCounts);
  const meanNumberOfNewContributorsPerWeek = mean(contributorCounts);

  // Remove known contributors from the recent ones.
  namesOfRecentContributors.forEach((name) => {
    if (namesOfContributors.has(name)) {
      namesOfRecentContributors.delete(name);
    } else {
      namesOfContributors.add(name);
    }
  });

  const metrics = JSON.stringify(
    {
      namesOfAdopters: adopterList,
      namesOfContributors: Array.from(namesOfContributors),
      namesOfContributorsNew: Array.from(namesOfRecentContributors),
      numberOfPullRequestNew: secondsToClosePulls.length,
      p50NumberOfNewPullsPerWeek,
      p50NumberOfNewContributorsPerWeek,
      p50SecondsToClosePulls,
      p50SecondsToCloseIssues,
      meanNumberOfNewPullsPerWeek,
      meanNumberOfNewContributorsPerWeek,
      meanSecondsToClosePulls,
      meanSecondsToCloseIssues,
    },
    null,
    2
  );

  console.log(metrics);

  /**
   * Commit the metrics back to the repo.
   */
  if (commitChanges) {
    const sha = await getCurrentMetricFileSha();

    await octokit.rest.repos.createOrUpdateFileContents({
      owner: REPO_ORG,
      repo: REPO_NAME,
      path: METRIC_FILENAME,
      message: "Updated metrics",
      sha,
      content: Buffer.from(metrics).toString("base64"),
      committer: {
        name: "Backstage Bot",
        email: "bot@backstage.io",
      },
    });
  }
};

main();

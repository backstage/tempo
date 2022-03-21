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
const writeChanges = "writeChanges" in argv;
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

if (!writeChanges) {
  console.log(
    "⚠️  Running in dryrun mode, no metrics will be commited back ⚠️"
  );
}

const getAdopterList = async () => {
  const adopters = new Set<string>();
  const response = await fetch(ADOPTER_MD_URL);
  const content = await response.text();
  const tokens = new Remarkable().parse(content, {});

  let isNextCell = false;

  const isBlockToken = (
    token: Remarkable.BlockContentToken
  ): token is Remarkable.BlockContentToken =>
    token.type === "inline" && Array.isArray(token.children);

  for (const token of tokens) {
    if (token.type === "tr_open") {
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
  const secondsToClosePulls: number[] = [];
  const secondsToCloseIssues: number[] = [];

  /**
   * Takes a pull request or issue and returns true/false
   * if it's within the range for metrics.
   */
  const isPullOrIssueWithinMetricsRange = (pullOrIssue: GithubPullOrIssue) => {
    return (
      DateTime.fromISO(pullOrIssue.created_at).diff(DateTime.now(), "days")
        .days < PAST_DAYS_FOR_METRICS
    );
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
    const secondsToClose = getSecondsToClose(pull);

    if (secondsToClose && isPullOrIssueWithinMetricsRange(pull))
      secondsToClosePulls.push(secondsToClose);
    if (pull.user?.login) namesOfContributors.add(pull.user.login);
  };

  /**
   * Takes an pull request, extract the metrics and stores them.
   */
  const getIssueMetrics = (issue: GithubIssue) => {
    const secondsToClose = getSecondsToClose(issue);

    if (secondsToClose && isPullOrIssueWithinMetricsRange(issue))
      secondsToCloseIssues.push(secondsToClose);
    if (issue.user?.login) namesOfContributors.add(issue.user.login);
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
            direction: "desc",
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
          octokit.rest.issues.list,
          {
            owner: REPO_ORG,
            repo: repo.name,
            per_page: 100,
            sort: "created",
            direction: "desc",
            state: "closed",
          }
        );

        // For each issue in the repo in the last N days
        for await (const { data: issues } of iteratorIssues) {
          console.log("Processing issues: ", issues.length);

          for (const issue of issues) {
            getIssueMetrics(issue);
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

  const metrics = JSON.stringify(
    {
      namesOfAdopters: adopterList,
      namesOfContributors: Array.from(namesOfContributors),
      p50SecondsToClosePulls,
      p50SecondsToCloseIssues,
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
  if (writeChanges) {
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

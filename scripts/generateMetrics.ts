import { Buffer } from "buffer";
import fs from "fs";
import path from "path";
import { Octokit, RestEndpointMethodTypes } from "@octokit/rest";
import minimist from "minimist";
import { DateTime } from "luxon";
import percentile from "percentile";
import mean from "lodash.mean";

const REPO_ORG = "backstage";
const REPO_NAME = "tempo";
const METRIC_FILENAME = "metrics.json";

const argv = minimist(process.argv.slice(2));
const isDryRun = "dryrun" in argv;
const maxDaysToInclude = 30;

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

if (isDryRun) {
  console.log(
    "⚠️  Running in dryrun mode, no metrics will be commited back ⚠️"
  );
}

const getCurrentFileSha = async () => {
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
  const namesOfAdopters: Set<string> = new Set();
  const namesOfContributors: Set<string> = new Set();
  const secondsToClosePulls: number[] = [];
  const secondsToCloseIssues: number[] = [];

  const getSecondsToClose = (
    pullOrIssue:
      | RestEndpointMethodTypes["pulls"]["list"]["response"]["data"][0]
      | RestEndpointMethodTypes["issues"]["list"]["response"]["data"][0]
  ) => {
    if (pullOrIssue.closed_at) {
      const dateCreatedAt = DateTime.fromISO(pullOrIssue.created_at);
      const dateClosedAt = DateTime.fromISO(pullOrIssue.closed_at);
      return dateClosedAt.diff(dateCreatedAt, "seconds").seconds;
    }
  };

  const getPullMetrics = (
    pull: RestEndpointMethodTypes["pulls"]["list"]["response"]["data"][0]
  ) => {
    const secondsToClose = getSecondsToClose(pull);

    if (secondsToClose) secondsToClosePulls.push(secondsToClose);
    if (pull.user?.name) namesOfContributors.add(pull.user.name);
  };

  const getIssueMetrics = (
    issue: RestEndpointMethodTypes["issues"]["list"]["response"]["data"][0]
  ) => {
    const secondsToClose = getSecondsToClose(issue);

    if (secondsToClose) secondsToCloseIssues.push(secondsToClose);
    if (issue.user?.name) namesOfContributors.add(issue.user.name);
  };

  for await (const { data: repos } of iteratorRepos) {
    for (const repo of repos) {
      console.log("Processing repo: ", repo.name);

      const iteratorPulls = octokit.paginate.iterator(octokit.rest.pulls.list, {
        owner: REPO_ORG,
        repo: repo.name,
        per_page: 100,
        sort: "created",
        direction: "desc",
        state: "closed",
      });

      pullIterator: for await (const { data: pulls } of iteratorPulls) {
        console.log("Processing pulls: ", pulls.length);

        for (const pull of pulls) {
          if (
            DateTime.now().diff(DateTime.fromISO(pull.created_at), "days")
              .days < maxDaysToInclude
          ) {
            getPullMetrics(pull);
          } else {
            break pullIterator;
          }
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

      issueIterator: for await (const { data: issues } of iteratorIssues) {
        console.log("Processing issues: ", issues.length);

        for (const issue of issues) {
          if (
            DateTime.fromISO(issue.created_at).diff(DateTime.now(), "days")
              .days < maxDaysToInclude
          ) {
            getIssueMetrics(issue);
          } else {
            break issueIterator;
          }
        }
      }
    }
  }

  const p50SecondsToClosePulls = percentile(50, secondsToClosePulls);
  const p50SecondsToCloseIssues = percentile(50, secondsToCloseIssues);
  const meanSecondsToClosePulls = mean(secondsToClosePulls);
  const meanSecondsToCloseIssues = mean(secondsToCloseIssues);

  const metrics = JSON.stringify(
    {
      namesOfAdopters: Array.from(namesOfAdopters),
      namesOfContributors: Array.from(namesOfContributors),
      p50SecondsToClosePulls,
      p50SecondsToCloseIssues,
      meanSecondsToClosePulls,
      meanSecondsToCloseIssues,
    },
    null,
    2
  );

  console.log("Metrics:", metrics);

  if (!isDryRun) {
    const sha = await getCurrentFileSha();

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

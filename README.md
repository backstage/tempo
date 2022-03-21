# tempo

Repo for collecting and storing open source metrics.

## Scripts

### `$ yarn generate`

Generates the metrics for the entire Backstage org.

#### Args

- `--withAdopterList` - Fetches and processes the adopter list
- `--withMetrics` - Fetches and processes pull request and issue metrics
- `--commitChange` - Commits the metric changes back to the repo, when omitted it runs in a dryrun mode.

## Shape of [metrics.json](./metrics.json)

```ts
{
    /**
     * List of the adopters taken from then
     * backstage/backstage/ADOPTERS.md file
     */
    namesOfAdopters: string[];
    /**
     * List of contributors that have either
     * submitted a pull request or opened
     * an issue.
     */
    namesOfContributors: string[];
    /**
     * List of new contributors that have either
     * submitted a pull request or opened
     * an issue.
     */
    namesOfContributorsNew: string[];
    /**
     * Number of pull requests in the last
     * month
     */
    numberOfPullRequestNew: number;
    /**
     * p50 of the time pull requests in the
     * last 30 days have been opened to the
     * time they were closed.
     */
    p50SecondsToClosePulls: number;
    /**
     * p50 of the time issues in the
     * last 30 days have been opened to the
     * time they were closed.
     */
    p50SecondsToCloseIssues: number;
    /**
     * mean of the time pull requests in the
     * last 30 days have been opened to the
     * time they were closed.
     */
    meanSecondsToClosePulls: number;
    /**
     * mean of the time issues in the
     * last 30 days have been opened to the
     * time they were closed.
     */
    meanSecondsToCloseIssues: number;
}
```

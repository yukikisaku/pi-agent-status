// Runs only from the default branch. PR files are read through the API, never executed.
const MARKER = '<!-- pi-ai-review:v1 -->';

function verdictFrom(review, policy) {
  if (review.user?.id !== policy.reviewerId || review.user?.login !== policy.reviewerLogin || review.state === 'PENDING') return null;
  // Submitted reviews cannot be deleted. Even a marker removed by editing supersedes old approvals.
  const match = review.body?.match(/^<!-- pi-ai-review:v1 -->\s*```json\s*([\s\S]*?)\s*```/);
  if (!match || review.state !== 'COMMENTED' || !review.submitted_at ||
      review.editInfo?.lastEditedAt !== null || review.editInfo?.editCount !== 0) return { invalid: true };
  try {
    const value = JSON.parse(match[1]);
    if (value.version !== 1 || value.headSha !== review.commit_id || !/^[a-f0-9]{40}$/.test(value.headSha) ||
        !/^[a-f0-9]{40}$/.test(value.baseSha) || !['approve', 'hold'].includes(value.decision) ||
        !Array.isArray(value.findings)) return { invalid: true };
    return value;
  } catch { return { invalid: true }; }
}

function isWakeup(comment, evidence, verdict, policy) {
  if (comment.user?.id !== policy.reviewerId || comment.user?.login !== policy.reviewerLogin) return false;
  if (comment.editInfo?.lastEditedAt !== null || comment.editInfo?.editCount !== 0) return false;
  return comment.body === '<!-- pi-ai-review-wakeup:v1 -->\n' + JSON.stringify({ reviewId: String(evidence.id),
    headSha: verdict.headSha, baseSha: verdict.baseSha });
}

function evaluate({ pr, policy, comments, reviews, threads, files, runs, jobs, checks, statuses }) {
  const hold = reason => ({ allowed: false, reason });
  if (policy.enabled !== true) return hold('automation disabled');
  if (pr.state !== 'open' || pr.draft || pr.locked) return hold('PR is closed, draft, or locked');
  if (pr.base.ref !== policy.baseBranch) return hold('not the configured base branch');
  if (pr.labels?.some(label => label.name === 'ai-merge:hold')) return hold('maintainer hold label');
  if (pr.mergeable !== true || pr.mergeable_state !== 'clean') return hold('mergeability is unknown, blocked, or not clean');
  // Privileged automation must be maintained through human-reviewed changes.
  if (files.some(file => [file.filename, file.previous_filename].some(path =>
    path && (path.startsWith('.github/') || path === 'docs/ai-review-operations.md')))) {
    return hold('automation or policy changes require manual merge');
  }
  const evidence = reviews.filter(review => verdictFrom(review, policy) !== null)
    .sort((a, b) => Number(b.id) - Number(a.id))[0];
  if (!evidence) return hold('no authenticated AI verdict');
  const verdict = verdictFrom(evidence, policy);
  if (verdict.invalid || verdict.headSha !== pr.head.sha || verdict.baseSha !== pr.base.sha ||
      verdict.decision !== 'approve' || verdict.findings.length !== 0) return hold('AI verdict is stale, invalid, or has findings');
  const reviewedAt = Date.parse(evidence.submitted_at);
  if (!Number.isFinite(reviewedAt)) return hold('invalid review timestamp');
  // GitHub timestamps have second precision: equality must hold for a fresh review.
  if (comments.some(comment => !isWakeup(comment, evidence, verdict, policy) && Date.parse(comment.updated_at) >= reviewedAt)) {
    return hold('discussion changed after AI review');
  }
  const latestReviews = new Map();
  for (const review of [...reviews].sort((a, b) => Number(a.id) - Number(b.id))) {
    if (review.id === evidence.id) continue;
    if (['APPROVED', 'CHANGES_REQUESTED'].includes(review.state)) latestReviews.set(review.user.id, review);
    if (Date.parse(review.submitted_at) >= reviewedAt || Date.parse(review.editInfo?.lastEditedAt) >= reviewedAt) return hold('new or edited review needs AI recheck');
  }
  if ([...latestReviews.values()].some(review => review.state === 'CHANGES_REQUESTED')) return hold('changes requested');
  if (threads.some(thread => !thread.isResolved)) return hold('unresolved review thread');
  if (threads.some(thread => thread.comments.nodes.some(comment => Date.parse(comment.updatedAt) >= reviewedAt))) {
    return hold('inline discussion changed after AI review');
  }
  const run = [...runs].sort((a, b) => Number(b.id) - Number(a.id))[0];
  if (!run || run.event !== 'pull_request' || run.head_sha !== pr.head.sha ||
      run.path !== policy.ciWorkflow || run.status !== 'completed' || run.conclusion !== 'success') {
    return hold('latest CI run for this head has not succeeded');
  }
  if (!policy.requiredJobs.every(name => jobs.some(job => job.name === name && job.conclusion === 'success')) ||
      jobs.some(job => job.status !== 'completed' || job.conclusion !== 'success')) return hold('required CI jobs have not succeeded');
  // Missing CI cannot pass vacuously. Neutral/skipped/cancelled checks never count as success.
  if (checks.length === 0 || checks.some(check => check.status !== 'completed' || check.conclusion !== 'success')) {
    return hold('head check runs are missing or not successful');
  }
  const latestStatuses = new Map();
  for (const status of [...statuses].sort((a, b) => Number(b.id) - Number(a.id))) {
    if (!latestStatuses.has(status.context)) latestStatuses.set(status.context, status);
  }
  if ([...latestStatuses.values()].some(status => status.state !== 'success')) return hold('head commit status is not successful');
  return { allowed: true, reason: 'review and CI passed for current head and base', headSha: pr.head.sha, baseSha: pr.base.sha };
}

async function reviewThreads(github, owner, repo, number) {
  const threads = [];
  let cursor = null;
  do {
    const data = await github.graphql(`query($owner:String!,$repo:String!,$number:Int!,$cursor:String) {
      repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
        reviewThreads(first:100,after:$cursor) { nodes {
          isResolved comments(first:100) { nodes { updatedAt } pageInfo { hasNextPage } }
        } pageInfo { hasNextPage endCursor } }
      } }
    }`, { owner, repo, number, cursor });
    const page = data.repository?.pullRequest?.reviewThreads;
    if (!page) throw new Error('Cannot read review threads');
    // A truncated thread must not silently discard new findings.
    if (page.nodes.some(thread => thread.comments.pageInfo.hasNextPage)) throw new Error('Review thread exceeds safe inspection limit');
    threads.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return threads;
}

async function reviewEdits(github, owner, repo, number) {
  const edits = new Map();
  let cursor = null;
  do {
    const data = await github.graphql(`query($owner:String!,$repo:String!,$number:Int!,$cursor:String) {
      repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
        reviews(first:100,after:$cursor) { nodes {
          id state submittedAt lastEditedAt userContentEdits(first:1) { totalCount }
        } pageInfo { hasNextPage endCursor } }
      } }
    }`, { owner, repo, number, cursor });
    const page = data.repository?.pullRequest?.reviews;
    if (!page) throw new Error('Cannot read review edit history');
    for (const review of page.nodes) edits.set(review.id, { lastEditedAt: review.lastEditedAt,
      editCount: review.userContentEdits?.totalCount, state: review.state, submittedAt: review.submittedAt });
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return edits;
}

async function inspectWakeups(github, comments, policy) {
  const candidates = comments.filter(comment => comment.user?.id === policy.reviewerId &&
    comment.user?.login === policy.reviewerLogin && comment.body?.startsWith('<!-- pi-ai-review-wakeup:v1 -->'));
  for (let offset = 0; offset < candidates.length; offset += 100) {
    const batch = candidates.slice(offset, offset + 100);
    if (batch.some(comment => !comment.node_id)) throw new Error('Missing notification identity');
    const result = await github.graphql(`query($ids:[ID!]!) { nodes(ids:$ids) {
      ... on IssueComment { id lastEditedAt userContentEdits(first:1) { totalCount } }
    } }`, { ids: batch.map(comment => comment.node_id) });
    const edits = new Map(result.nodes.filter(Boolean).map(node => [node.id, {
      lastEditedAt: node.lastEditedAt, editCount: node.userContentEdits?.totalCount }]));
    for (const comment of batch) comment.editInfo = edits.get(comment.node_id);
  }
}

async function inspect(github, params, policy) {
  const { owner, repo, pull_number: number } = params;
  const { data: pr } = await github.rest.pulls.get(params);
  const [comments, reviews, edits, threads, files, runData, checkData, statuses] = await Promise.all([
    github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 }),
    github.paginate(github.rest.pulls.listReviews, { ...params, per_page: 100 }),
    reviewEdits(github, owner, repo, number),
    reviewThreads(github, owner, repo, number),
    github.paginate(github.rest.pulls.listFiles, { ...params, per_page: 100 }),
    github.rest.actions.listWorkflowRuns({ owner, repo, workflow_id: policy.ciWorkflow.split('/').pop(),
      event: 'pull_request', head_sha: pr.head.sha, per_page: 100 }),
    github.paginate(github.rest.checks.listForRef, { owner, repo, ref: pr.head.sha, filter: 'latest', per_page: 100 }),
    github.paginate(github.rest.repos.listCommitStatusesForRef, { owner, repo, ref: pr.head.sha, per_page: 100 }),
  ]);
  // REST caps PR file listings at 3000. Refuse incomplete inspections.
  if (files.length !== pr.changed_files) return { allowed: false, reason: 'incomplete changed-file list' };
  if (reviews.some(review => review.state !== 'PENDING' && (!edits.has(review.node_id) ||
      edits.get(review.node_id).state !== review.state || edits.get(review.node_id).submittedAt !== review.submitted_at))) {
    return { allowed: false, reason: 'incomplete review edit-history inspection' };
  }
  const submittedIds = new Set(reviews.filter(review => review.state !== 'PENDING').map(review => review.node_id));
  if ([...edits].some(([id, edit]) => edit.state !== 'PENDING' && !submittedIds.has(id))) {
    return { allowed: false, reason: 'submitted reviews changed during inspection' };
  }
  for (const review of reviews) review.editInfo = edits.get(review.node_id);
  await inspectWakeups(github, comments, policy);
  const runs = runData.data.workflow_runs;
  const run = [...runs].sort((a, b) => Number(b.id) - Number(a.id))[0];
  const jobs = run ? await github.paginate(github.rest.actions.listJobsForWorkflowRun,
    { owner, repo, run_id: run.id, filter: 'latest', per_page: 100 }) : [];
  return evaluate({ pr, policy, comments, reviews, threads, files, runs, jobs, checks: checkData, statuses });
}

async function run({ github, context, core, policy }) {
  const { owner, repo } = context.repo;
  if (policy.enabled !== true) { core.info('Automatic merge is disabled'); return; }
  // Serial workflow execution prevents two gate runs from merging concurrently.
  if (context.eventName === 'issue_comment') {
    if (!context.payload.issue?.pull_request) return;
  }
  // Every wake-up inspects all open PRs, including when concurrency coalesces events.
  const numbers = (await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open',
    base: policy.baseBranch, per_page: 100 })).map(pr => pr.number);
  for (const number of numbers) {
    const params = { owner, repo, pull_number: number };
    try {
      const verdict = await inspect(github, params, policy);
      if (!verdict.allowed) { core.info(`PR #${number}: held (${verdict.reason})`); continue; }
      // Re-read all mutable safety conditions immediately before the write.
      const confirmed = await inspect(github, params, policy);
      if (!confirmed.allowed || confirmed.headSha !== verdict.headSha || confirmed.baseSha !== verdict.baseSha) {
        core.info(`PR #${number}: held (state changed during inspection)`); continue;
      }
      const { data: branch } = await github.rest.repos.getBranch({ owner, repo, branch: policy.baseBranch });
      if (branch.commit.sha !== confirmed.baseSha) { core.info(`PR #${number}: held (base advanced)`); continue; }
      // GitHub rejects the write if the PR head changed after inspection.
      const { data: result } = await github.rest.pulls.merge({ ...params, sha: confirmed.headSha, merge_method: 'squash' });
      if (!result.merged) throw new Error('GitHub refused the merge');
      core.info(`PR #${number}: merged reviewed head ${confirmed.headSha}`);
    } catch (error) {
      // Permission failures, unavailable APIs, and protection failures never bypass the gate.
      core.warning(`PR #${number}: held (${error.status || error.name || 'API error'})`);
    }
  }
}

module.exports = { MARKER, verdictFrom, evaluate, inspect, run };

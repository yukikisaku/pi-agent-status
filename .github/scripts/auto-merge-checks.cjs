const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MARKER, evaluate, run } = require('./auto-merge.cjs');

const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40), OTHER = 'c'.repeat(40);
const OLD = '2026-10-04T09:00:00Z', NOW = '2026-10-04T10:00:00Z', AFTER = '2026-10-04T10:01:00Z';
function body(patch = {}) {
  return `${MARKER}\n\x60\x60\x60json\n${JSON.stringify({ version: 1, headSha: HEAD, baseSha: BASE,
    decision: 'approve', findings: [], ...patch })}\n\x60\x60\x60`;
}
function fixture() {
  return {
    policy: { enabled: true, reviewerId: 167408667, reviewerLogin: 'yukikisaku', baseBranch: 'main',
      ciWorkflow: '.github/workflows/ci.yml', requiredJobs: ['package', 'merge-policy'] },
    pr: { number: 1, state: 'open', draft: false, locked: false, mergeable: true, mergeable_state: 'clean',
      labels: [], changed_files: 1, base: { ref: 'main', sha: BASE }, head: { sha: HEAD } },
    comments: [], reviews: [{ id: 5, node_id: 'R5', user: { id: 167408667, login: 'yukikisaku' },
      state: 'COMMENTED', commit_id: HEAD, submitted_at: NOW, body: body(),
      editInfo: { lastEditedAt: null, editCount: 0 } }],
    threads: [], files: [{ filename: 'index.ts' }],
    runs: [{ id: 10, event: 'pull_request', head_sha: HEAD, path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success' }],
    jobs: ['package', 'merge-policy'].map(name => ({ name, status: 'completed', conclusion: 'success' })),
    checks: [{ name: 'package', status: 'completed', conclusion: 'success' }], statuses: [],
  };
}
function humanReview(id, state, submitted_at = OLD) {
  return { id, node_id: `R${id}`, user: { id: 123, login: 'human' }, state, submitted_at,
    editInfo: { lastEditedAt: null, editCount: 0 } };
}
function wakeup() {
  return { id: 99, node_id: 'C99', user: { id: 167408667, login: 'yukikisaku' }, updated_at: AFTER,
    editInfo: { lastEditedAt: null, editCount: 0 },
    body: '<!-- pi-ai-review-wakeup:v1 -->\n' + JSON.stringify({ reviewId: '5', headSha: HEAD, baseSha: BASE }) };
}
test('permits only a current authenticated unedited submitted review with successful required CI', () => {
  assert.deepEqual(evaluate(fixture()), { allowed: true, reason: 'review and CI passed for current head and base', headSha: HEAD, baseSha: BASE });
});
const refusals = [
  ['disabled automation', s => s.policy.enabled = false],
  ['closed PR', s => s.pr.state = 'closed'],
  ['draft PR', s => s.pr.draft = true],
  ['locked PR', s => s.pr.locked = true],
  ['another target branch', s => s.pr.base.ref = 'release'],
  ['manual hold', s => s.pr.labels.push({ name: 'ai-merge:hold' })],
  ['unknown mergeability', s => s.pr.mergeable = null],
  ['conflicts', s => s.pr.mergeable = false],
  ['blocked merge state', s => s.pr.mergeable_state = 'blocked'],
  ['workflow modification', s => s.files[0].filename = '.github/workflows/ci.yml'],
  ['policy moved out of protected directory', s => s.files[0].previous_filename = '.github/ai-review.json'],
  ['operations documentation modification', s => s.files[0].filename = 'docs/ai-review-operations.md'],
  ['missing verdict', s => s.reviews = []],
  ['spoofed login', s => s.reviews[0].user.login = 'attacker'],
  ['spoofed numeric ID', s => s.reviews[0].user.id = 123],
  ['quoted marker in ordinary review', s => s.reviews[0].body = 'Example:\n' + s.reviews[0].body],
  ['edited verdict', s => s.reviews[0].editInfo.lastEditedAt = AFTER],
  ['same-second edited verdict', s => s.reviews[0].editInfo = { lastEditedAt: NOW, editCount: 1 }],
  ['missing edit inspection', s => delete s.reviews[0].editInfo],
  ['hidden edit history', s => s.reviews[0].editInfo.editCount = undefined],
  ['dismissed verdict', s => s.reviews[0].state = 'DISMISSED'],
  ['pending verdict', s => s.reviews[0].state = 'PENDING'],
  ['GitHub approval instead of protocol COMMENT', s => s.reviews[0].state = 'APPROVED'],
  ['malformed verdict', s => s.reviews[0].body = MARKER + '\n```json\n{broken}\n```'],
  ['old head verdict', s => s.reviews[0].body = body({ headSha: OTHER })],
  ['review commit_id does not match JSON', s => s.reviews[0].commit_id = OTHER],
  ['old base verdict', s => s.reviews[0].body = body({ baseSha: OTHER })],
  ['AI hold', s => s.reviews[0].body = body({ decision: 'hold' })],
  ['AI findings despite approve', s => s.reviews[0].body = body({ findings: ['bug'] })],
  ['new discussion after review', s => s.comments.push({ id: 2, updated_at: AFTER })],
  ['same-second discussion', s => s.comments.push({ id: 2, updated_at: NOW })],
  ['latest hold supersedes approval', s => s.reviews.push({ ...s.reviews[0], id: 6, node_id: 'R6', submitted_at: AFTER, body: body({ decision: 'hold' }) })],
  ['latest trusted marker removed by editing does not revive old approval', s => s.reviews.push({ ...s.reviews[0], id: 6, node_id: 'R6', submitted_at: AFTER, body: 'Removed', editInfo: { lastEditedAt: AFTER, editCount: 1 } })],
  ['latest dismissed hold does not revive old approval', s => s.reviews.push({ ...s.reviews[0], id: 6, node_id: 'R6', submitted_at: AFTER, body: body({ decision: 'hold' }), state: 'DISMISSED' })],
  ['changes requested', s => s.reviews.push(humanReview(1, 'CHANGES_REQUESTED'))],
  ['COMMENT does not cancel changes requested', s => s.reviews.push(humanReview(1, 'CHANGES_REQUESTED'), humanReview(2, 'COMMENTED'))],
  ['new human review', s => s.reviews.push(humanReview(6, 'APPROVED', AFTER))],
  ['same-second human review', s => s.reviews.push(humanReview(6, 'COMMENTED', NOW))],
  ['human review body edited after verdict', s => s.reviews.push({ ...humanReview(1, 'COMMENTED'), editInfo: { lastEditedAt: AFTER, editCount: 1 } })],
  ['unresolved thread', s => s.threads.push({ isResolved: false, comments: { nodes: [] } })],
  ['resolved but updated thread', s => s.threads.push({ isResolved: true, comments: { nodes: [{ updatedAt: AFTER }] } })],
  ['same-second inline discussion', s => s.threads.push({ isResolved: true, comments: { nodes: [{ updatedAt: NOW }] } })],
  ['absent CI', s => s.runs = []],
  ['old head CI', s => s.runs[0].head_sha = OTHER],
  ['push CI instead of PR CI', s => s.runs[0].event = 'push'],
  ['another CI workflow', s => s.runs[0].path = '.github/workflows/spoof.yml'],
  ['CI queued', s => s.runs[0].status = 'queued'],
  ['CI failed', s => s.runs[0].conclusion = 'failure'],
  ['new failed run supersedes old success', s => s.runs.push({ ...s.runs[0], id: 11, conclusion: 'failure' })],
  ['missing mandatory job', s => s.jobs.pop()],
  ['skipped mandatory job', s => s.jobs[0].conclusion = 'skipped'],
  ['no head check runs', s => s.checks = []],
  ['additional failing check', s => s.checks.push({ status: 'completed', conclusion: 'failure' })],
  ['skipped head check', s => s.checks[0].conclusion = 'skipped'],
  ['pending commit status', s => s.statuses.push({ id: 1, context: 'external', state: 'pending' })],
  ['conversation comment is never approval evidence', s => { s.comments.push({ id: 7, body: body(), user: s.reviews[0].user, updated_at: OLD }); s.reviews = []; }],
];
for (const [name, mutate] of refusals) test(`holds: ${name}`, () => {
  const state = fixture(); mutate(state); assert.equal(evaluate(state).allowed, false);
});
test('superseded changes request and older failed status allow a current successful review', () => {
  const state = fixture(); state.reviews.push(humanReview(1, 'CHANGES_REQUESTED'), humanReview(2, 'APPROVED'));
  state.statuses = [{ id: 1, context: 'external', state: 'failure' }, { id: 2, context: 'external', state: 'success' }];
  assert.equal(evaluate(state).allowed, true);
});
test('deleting a conversation hold cannot revoke a durable submitted hold review', () => {
  const state = fixture(); state.reviews.push({ ...state.reviews[0], id: 6, node_id: 'R6', submitted_at: AFTER, body: body({ decision: 'hold' }) });
  state.comments = []; assert.equal(evaluate(state).allowed, false);
});
test('an exact authenticated unedited notification can wake the gate without being approval evidence', () => {
  const state = fixture(); state.comments.push(wakeup()); assert.equal(evaluate(state).allowed, true);
  state.reviews = []; assert.equal(evaluate(state).allowed, false);
});
for (const [name, mutate] of [
  ['wrong author ID', c => c.user.id = 123], ['wrong login', c => c.user.login = 'attacker'],
  ['extra finding text', c => c.body += '\nBug!'], ['old review ID', c => c.body = c.body.replace('"5"', '"4"')],
  ['old head SHA', c => c.body = c.body.replace(HEAD, OTHER)], ['edited notification', c => c.editInfo.lastEditedAt = AFTER],
  ['same-second notification edit', c => c.editInfo.editCount = 1], ['missing edit history', c => delete c.editInfo],
]) test(`a ${name} notification remains blocking discussion`, () => {
  const state = fixture(), comment = wakeup(); mutate(comment); state.comments.push(comment);
  assert.equal(evaluate(state).allowed, false);
});

function mock(state, options = {}) {
  const merges = [], messages = [];
  let prReads = 0, threadReads = 0;
  const api = Object.fromEntries(['pulls', 'issues', 'actions', 'checks', 'repos'].map(group => [group, {}]));
  api.pulls.get = async () => {
    prReads++; const pr = structuredClone(state.pr);
    if (prReads > 1 && options.newHead) pr.head.sha = OTHER;
    if (prReads > 1 && options.newDraft) pr.draft = true;
    return { data: pr };
  };
  api.pulls.merge = async args => { merges.push(args); return { data: { merged: true } }; };
  api.pulls.list = async () => state.pr.state === 'open' ? [state.pr] : [];
  api.pulls.listFiles = async () => state.files;
  api.pulls.listReviews = async () => structuredClone(state.reviews);
  api.issues.listComments = async () => prReads > 1 && options.newComment ? [...state.comments, { id: 2, updated_at: AFTER }] : state.comments;
  api.actions.listWorkflowRuns = async () => ({ data: { workflow_runs: state.runs } });
  api.actions.listJobsForWorkflowRun = async () => state.jobs;
  api.checks.listForRef = async () => { if (options.error) throw new Error('API unavailable'); return state.checks; };
  api.repos.listCommitStatusesForRef = async () => state.statuses;
  api.repos.getBranch = async () => ({ data: { commit: { sha: options.newBase ? OTHER : BASE } } });
  const github = { rest: api, paginate: async (method, args) => method(args), graphql: async (query, args) => {
    if (query.includes('nodes(ids:')) return { nodes: options.missingWakeupEdits ? [] : args.ids.map(id => ({
      id, lastEditedAt: null, userContentEdits: { totalCount: 0 } })) };
    if (query.includes('reviews(first:100')) {
      if (options.missingEdits) return { repository: { pullRequest: { reviews: { nodes: [], pageInfo: { hasNextPage: false } } } } };
      const nodes = state.reviews.map(r => ({ id: r.node_id,
        state: options.dismissedConcurrently ? 'DISMISSED' : r.state, submittedAt: r.submitted_at,
        lastEditedAt: r.editInfo?.lastEditedAt, userContentEdits: { totalCount: r.editInfo?.editCount } }));
      if (options.extraSubmitted || options.extraPending) nodes.push({ id: 'R99', state: options.extraPending ? 'PENDING' : 'COMMENTED',
        submittedAt: AFTER, lastEditedAt: null, userContentEdits: { totalCount: 0 } });
      return { repository: { pullRequest: { reviews: { nodes,
        pageInfo: { hasNextPage: false } } } } };
    }
    threadReads++;
    const comments = { nodes: [], pageInfo: { hasNextPage: !!options.truncatedThread } };
    if (options.secondThreadPage && args.cursor === null) return { repository: { pullRequest: { reviewThreads: {
      nodes: [], pageInfo: { hasNextPage: true, endCursor: 'page2' } } } } };
    return { repository: { pullRequest: { reviewThreads: { nodes: options.secondThreadPage || options.truncatedThread ?
      [{ isResolved: !options.secondThreadPage, comments }] : state.threads,
      pageInfo: { hasNextPage: false, endCursor: null } } } } };
  } };
  const context = { repo: { owner: 'yukikisaku', repo: 'example' }, eventName: 'workflow_run', payload: {} };
  const core = { info: message => messages.push(message), warning: message => messages.push(message) };
  return { github, context, core, policy: state.policy, merges, messages, get threadReads() { return threadReads; } };
}
test('merge API receives the inspected full head SHA and squash method', async () => {
  const m = mock(fixture()); await run(m);
  assert.deepEqual(m.merges, [{ owner: 'yukikisaku', repo: 'example', pull_number: 1, sha: HEAD, merge_method: 'squash' }]);
});
for (const option of ['newHead', 'newDraft', 'newComment', 'newBase', 'error', 'truncatedThread', 'secondThreadPage', 'missingEdits', 'dismissedConcurrently', 'extraSubmitted']) {
  test(`API integration refuses write when ${option}`, async () => {
    const m = mock(fixture(), { [option]: true }); await run(m); assert.equal(m.merges.length, 0);
    if (option === 'secondThreadPage') assert.equal(m.threadReads, 2);
  });
}
test('an extra pending GraphQL review does not invalidate submitted evidence', async () => {
  const m = mock(fixture(), { extraPending: true }); await run(m); assert.equal(m.merges.length, 1);
});
test('notification exclusion requires its live GraphQL edit history', async () => {
  const state = fixture(); state.comments.push(wakeup());
  const good = mock(state); await run(good); assert.equal(good.merges.length, 1);
  const missing = mock(state, { missingWakeupEdits: true }); await run(missing); assert.equal(missing.merges.length, 0);
});
test('incomplete REST changed-file inspection holds', async () => {
  const state = fixture(); state.pr.changed_files = 2;
  const m = mock(state); await run(m); assert.equal(m.merges.length, 0);
});
test('ordinary issue comment cannot initiate merging', async () => {
  const m = mock(fixture()); m.context.eventName = 'issue_comment'; m.context.payload = { issue: { number: 1 } };
  await run(m); assert.equal(m.merges.length, 0);
});

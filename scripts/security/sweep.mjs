#!/usr/bin/env node
// The adversarial sweep of docs/SECURITY.md, black-box over HTTP against any stack: a local production-mode stack
// (no test hooks) in ci.yml's build job, staging for T8.3. It signs up its own @example.invalid principals, then checks
// headers, existence leaks, test hooks, client header stripping, the origin gate, token threading and revocation
// (share links, agent keys, sessions, sockets included), SSRF refusals, body caps and rate limits. Each check prints
// one line; the exit code is 1 when any failed. A run sends about 1,000
// requests; the limit checks (about 250) run last, because they exhaust the sign-in window for this address.
//   node scripts/security/sweep.mjs --base-url URL [--json] [--skip-limits]
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';
import { comparable, hookProblems } from '../deploy/assert-deployed.mjs';

const TIMEOUT_MS = 20_000;
const MISSING = '00000000-0000-4000-8000-000000000000';
/** Matches apps/web/src/api/respond.ts JSON_BODY_CAP. */
export const JSON_BODY_CAP = 1024 * 1024;

/** Internal targets the SSRF guard must refuse before fetching anything (A§18). */
export const SSRF_URLS = [
  'http://example.com/',
  'file:///etc/passwd',
  'https://127.0.0.1/',
  'https://localhost/',
  'https://[::1]/',
  'https://169.254.169.254/latest/meta-data/',
  'https://10.0.0.1/',
  'https://192.168.1.1/',
  'https://100.64.0.1/',
  'https://[fd00::1]/',
  'https://[::ffff:127.0.0.1]/',
  'https://[::ffff:7f00:1]/',
  'https://2130706433/',
  'https://0x7f000001/',
  'https://0177.0.0.1/',
  'https://127.1/',
  'https://user:pass@example.com/',
  'https://example.com:8443/',
  'https://metadata/',
  'https://localhost./',
];

/** The app's own scheme and host on a different, non-default port: a same-site origin the gate must refuse. */
export function otherPortOrigin(baseUrl) {
  const url = new URL(baseUrl);
  const fallback = url.protocol === 'https:' ? 443 : 80;
  const current = url.port ? Number(url.port) : fallback;
  let port = current === 65535 ? current - 1 : current + 1;
  if (port === fallback) port += 1;
  const app = url.origin;
  url.port = String(port);
  if (url.origin === app || !url.port) throw new Error(`no different-port origin for ${app}`);
  return url.origin;
}

/** True for a stack on this machine; anything else is reached through Cloudflare's edge. */
export function isLoopback(baseUrl) {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseUrl).hostname);
}

export function createSweep(baseUrl) {
  const base = new URL(baseUrl).origin;
  const edge = !isLoopback(base);
  const results = [];
  const check = (area, name, ok, detail = '') => {
    results.push({ area, name, ok: Boolean(ok), detail });
    return Boolean(ok);
  };

  async function call(method, path, { headers = {}, body, raw } = {}) {
    const init = { method, headers: { ...headers }, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) };
    if (raw !== undefined) init.body = raw;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers['content-type'] = 'application/json';
    }
    const response = await fetch(`${base}${path}`, init);
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: response.status, headers: response.headers, text, json };
  }

  const as = (who) => (who ? who.headers : {});
  const write = (who) => ({ ...as(who), origin: base });

  async function signUp(label) {
    const email = `mm-sweep-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}-${label}@example.invalid`;
    const password = randomBytes(18).toString('base64url');
    const response = await call('POST', '/api/auth/sign-up/email', { headers: { origin: base }, body: { email, password, name: `Sweep ${label}` } });
    if (response.status !== 200) throw new Error(`sign-up ${label}: ${response.status} ${response.text.slice(0, 200)}`);
    const cookie = response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const token = response.headers.get('set-auth-token');
    return { label, email, password, id: response.json.user.id, cookie, token, headers: { cookie }, setCookies: response.headers.getSetCookie() };
  }

  const bearer = (token) => ({ headers: { authorization: `Bearer ${token}` } });

  /**
   * A raw WebSocket upgrade: 'open' when the server keeps it open and talks, else the close code it sends, or the HTTP
   * status when it never upgrades. Node's WebSocket cannot send a Cookie or Origin, so this speaks the handshake itself.
   */
  function socket(path, headers = {}) {
    const url = new URL(path, base);
    const client = url.protocol === 'https:' ? https : http;
    return new Promise((done) => {
      const request = client.request(url, {
        headers: {
          connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
          'sec-websocket-key': randomBytes(16).toString('base64'), ...headers,
        },
        timeout: TIMEOUT_MS,
      });
      const timer = setTimeout(() => {
        request.destroy();
        done('timeout');
      }, TIMEOUT_MS);
      request.on('response', (response) => {
        clearTimeout(timer);
        response.resume();
        done(`http ${response.statusCode}`);
      });
      request.on('error', (error) => {
        clearTimeout(timer);
        done(`error ${error.code ?? error.message}`);
      });
      request.on('upgrade', (_response, stream, head) => {
        // The first frames can arrive with the 101 itself, in `head`.
        let buffer = Buffer.from(head);
        let settled = false;
        const finish = (verdict) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(quiet);
          stream.destroy();
          done(verdict);
        };
        // A socket the server admits stays open; one it refuses is closed at once after the upgrade.
        const quiet = setTimeout(() => finish('open'), 3_000);
        const parse = () => {
          while (buffer.length >= 2) {
            const opcode = buffer[0] & 0x0f;
            let length = buffer[1] & 0x7f;
            let offset = 2;
            if (length === 126) {
              if (buffer.length < 4) return;
              length = buffer.readUInt16BE(2);
              offset = 4;
            } else if (length === 127) {
              if (buffer.length < 10) return;
              length = Number(buffer.readBigUInt64BE(2));
              offset = 10;
            }
            if (buffer.length < offset + length) return;
            if (opcode === 0x8) return finish(length >= 2 ? `close ${buffer.readUInt16BE(offset)}` : 'close');
            buffer = buffer.subarray(offset + length);
          }
        };
        stream.on('data', (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          parse();
        });
        stream.on('close', () => finish('ended'));
        stream.on('error', () => finish('ended'));
        parse();
      });
      request.end();
    });
  }

  const docSocket = (docId, query = '') => `/parties/doc-d-o/${docId}?protocol=999${query}`;

  /**
   * The status an oversized request gets, on a connection of its own (a server that answers before reading the body
   * closes it): with `body`, sent whole; without, it declares `length` bytes and sends none, so the refusal must
   * come from the header. Off loopback Cloudflare's edge holds a request until its whole body has arrived, so there
   * the declared bytes are sent (spaces) and the Worker's answer to the whole body counts.
   */
  function oversized(method, path, headers, length, body) {
    const url = new URL(path, base);
    const client = url.protocol === 'https:' ? https : http;
    if (!body && edge) body = Buffer.alloc(length, 0x20);
    return new Promise((done) => {
      const request = client.request(url, { method, agent: false, headers: { ...headers, 'content-length': String(length) } });
      const timer = setTimeout(() => {
        request.destroy();
        done('no answer');
      }, edge ? 60_000 : 15_000);
      request.on('response', (response) => {
        clearTimeout(timer);
        response.resume();
        request.destroy();
        done(response.statusCode);
      });
      request.on('error', (error) => {
        clearTimeout(timer);
        done(`error ${error.code ?? error.message}`);
      });
      if (body) request.end(body);
      else request.flushHeaders();
    });
  }

  /** Status and body equal: the answer says nothing about whether the thing exists. */
  const same = (a, b) => a.status === b.status && a.text === b.text;

  async function headers() {
    const area = 'headers';
    const page = await call('GET', '/login');
    const csp = page.headers.get('content-security-policy') ?? '';
    const scriptSrc = /script-src([^;]*)/.exec(csp)?.[1] ?? '';
    check(area, 'an app page carries a CSP whose scripts need the per-request nonce', /'nonce-[^']+'/.test(scriptSrc) && !scriptSrc.includes("'unsafe-inline'") && !scriptSrc.includes('*'), csp);
    check(area, "an app page may be framed only by the app (frame-ancestors 'self')", /frame-ancestors 'self'(;|$)/.test(csp), csp);
    const frame = await call('GET', '/frame/html');
    const framePolicy = frame.headers.get('content-security-policy') ?? '';
    check(area, '/frame/html is sandboxed to an opaque origin (no allow-same-origin)', /(^|;\s*)sandbox allow-scripts(;|$)/.test(framePolicy) && !framePolicy.includes('allow-same-origin'), framePolicy);
    check(area, '/frame/html is nosniff', frame.headers.get('x-content-type-options') === 'nosniff');
    const unknown = await call('GET', `/api/no-such-route-${randomBytes(4).toString('hex')}`);
    check(area, 'an unknown /api path is a JSON 404, never HTML', unknown.status === 404 && (unknown.headers.get('content-type') ?? '').startsWith('application/json'));
    const me = await call('GET', '/api/me');
    check(area, 'a per-caller /api answer is no-store', me.headers.get('cache-control') === 'no-store');
  }

  async function hooks() {
    const problems = await hookProblems(base);
    check('test hooks', 'every /__test path, with or without a hook header, is the unknown-route 404', problems.length === 0, problems.join('; '));
  }

  async function run({ limits = true } = {}) {
    await headers();
    await hooks();

    const ada = await signUp('ada');
    const ben = await signUp('ben');
    const cy = await signUp('cy');
    const session = ada.setCookies.find((c) => /^[^=]*session_token=/.test(c)) ?? '';
    const flags = session.split(';').slice(1).map((f) => f.trim().toLowerCase());
    check('headers', `the session cookie is HttpOnly, SameSite=Lax${base.startsWith('https:') ? ' and Secure' : ''}`,
      flags.includes('httponly') && flags.includes('samesite=lax') && (!base.startsWith('https:') || flags.includes('secure')), flags.join('; '));

    // Ada's estate: a note with a comment and an SVG, a viewer link, a trashed note and an agent key.
    const created = await call('POST', '/api/docs', { headers: write(ada), body: { markdown: 'Sweep note body\n' } });
    if (created.status !== 201) throw new Error(`create: ${created.status} ${created.text.slice(0, 200)}`);
    const doc = created.json.doc;
    const trashedDoc = (await call('POST', '/api/docs', { headers: write(ada), body: {} })).json.doc;
    await call('DELETE', `/api/docs/${trashedDoc.id}`, { headers: write(ada) });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const uploaded = await call('POST', `/api/docs/${doc.id}/assets?filename=sweep.svg`, { headers: { ...write(ada), 'content-type': 'image/svg+xml' }, raw: svg });
    check('setup', 'the owner uploads an SVG', uploaded.status === 201 || uploaded.status === 200, `${uploaded.status} ${uploaded.text.slice(0, 120)}`);
    const comment = await call('POST', `/api/docs/${doc.id}/comments`, { headers: write(ada), body: { id: 'sweep-c0', text: 'sweep comment', anchor: { quote: 'Sweep note' } } });
    check('setup', 'the owner comments', comment.status === 201, `${comment.status} ${comment.text.slice(0, 120)}`);
    const link = (await call('POST', `/api/docs/${doc.id}/links`, { headers: write(ada), body: { role: 'viewer' } })).json?.link?.token;
    check('setup', 'the owner makes a viewer link', Boolean(link));
    const agent = await call('POST', '/api/agents', { headers: write(ada), body: { name: 'Sweep agent' } });
    const agentKey = agent.json?.key;
    const benAgent = (await call('POST', '/api/agents', { headers: write(ben), body: { name: 'Ben agent' } })).json?.key;
    check('setup', 'agent keys are minted', Boolean(agentKey && benAgent));
    const home = (await call('GET', '/api/vaults', { headers: ada.headers })).json?.vaults?.[0]?.id;
    check('setup', "the owner's Home vault is listed", Boolean(home));

    // ---- headers on user content
    const asset = await call('GET', `/api/docs/${doc.id}/assets/sweep.svg`, { headers: ada.headers });
    check('headers', 'an SVG asset is served sandboxed and nosniff', asset.status === 200 && /sandbox/.test(asset.headers.get('content-security-policy') ?? '') && asset.headers.get('x-content-type-options') === 'nosniff',
      `${asset.status} ${asset.headers.get('content-security-policy')}`);

    // ---- existence: a stranger's answer for Ada's note equals the answer for no note at all, on every route
    const forged = `${randomBytes(24).toString('hex')}`;
    const strangers = [
      ['a stranger (cookie)', write(ben)],
      ['a stranger (session bearer)', { authorization: `Bearer ${ben.token}` }],
      ["a stranger's agent key", { authorization: `Bearer ${benAgent}` }],
      ['a forged share token alone', { 'x-moss-share': forged }],
      ['a stranger with forged trusted headers', { ...write(ben), 'x-moss-principal': ada.id, 'x-moss-role': 'owner', 'x-moss-session': 'forged', 'x-partykit-room': doc.id }],
    ];
    const docRoutes = [
      ['GET', ''], ['PATCH', '', { title: 'pwned' }], ['DELETE', ''], ['GET', '/access'], ['GET', '/content'],
      ['GET', '/content?view=working'], ['GET', '/comments'], ['POST', '/comments', { body: 'x' }], ['GET', '/members'],
      ['POST', '/members', { email: 'x@example.invalid', role: 'editor' }], ['GET', '/invites'], ['GET', '/links'],
      ['POST', '/links', { role: 'editor' }], ['GET', '/versions'], ['POST', '/versions', { name: 'v' }], ['GET', '/suggestions'],
      ['GET', '/instance'], ['GET', '/backlinks'], ['GET', '/headings'], ['POST', '/duplicate', {}], ['POST', '/restore', {}],
      ['POST', '/push', { newText: 'x', baseHash: '0'.repeat(64) }], ['GET', '/assets/sweep.svg'],
      ['POST', '/assets/copy', { sourceNoteId: doc.id, sourceRelativePath: 'assets/sweep.svg' }],
      ['POST', '/assets/from-url', { url: 'https://example.com/a.png' }],
    ];
    for (const [who, headers] of strangers) {
      const leaks = [];
      for (const [method, suffix, body] of docRoutes) {
        for (const target of [doc.id, trashedDoc.id]) {
          const real = await call(method, `/api/docs/${target}${suffix}`, { headers, body });
          const none = await call(method, `/api/docs/${MISSING}${suffix}`, { headers, body });
          if (real.status < 400 || !same(real, none)) leaks.push(`${method} ${suffix || '/'}${target === trashedDoc.id ? ' (trashed)' : ''}: ${real.status} vs ${none.status}`);
        }
      }
      const unfurl = async (noteId) => call('POST', '/api/unfurl', { headers, body: { noteId, url: 'https://example.com/' } });
      if (!same(await unfurl(doc.id), await unfurl(MISSING))) leaks.push('POST /api/unfurl');
      for (const [method, suffix, body] of [['GET', ''], ['PATCH', '', { name: 'x' }], ['DELETE', ''], ['GET', '/members'], ['GET', '/links'], ['GET', '/invites']]) {
        const real = await call(method, `/api/folders/${home}${suffix}`, { headers, body });
        const none = await call(method, `/api/folders/${MISSING}${suffix}`, { headers, body });
        if (real.status < 400 || !same(real, none)) leaks.push(`${method} /api/folders${suffix}: ${real.status} vs ${none.status}`);
      }
      for (const [method, body] of [['PATCH', { name: 'x' }], ['DELETE']]) {
        const real = await call(method, `/api/vaults/${home}`, { headers, body });
        const none = await call(method, `/api/vaults/${MISSING}`, { headers, body });
        if (real.status < 400 || !same(real, none)) leaks.push(`${method} /api/vaults/:id: ${real.status} vs ${none.status}`);
      }
      const trash = await call('GET', `/api/trash/${trashedDoc.id}`, { headers });
      if (!same(trash, await call('GET', `/api/trash/${MISSING}`, { headers }))) leaks.push('GET /api/trash/:id');
      const party = await call('GET', `/parties/doc-d-o/${doc.id}?protocol=999`, { headers });
      if (!same(party, await call('GET', `/parties/doc-d-o/${MISSING}?protocol=999`, { headers }))) leaks.push('GET /parties');
      check('existence', `${who}: every doc, folder, vault, trash and party route answers as for a missing id`, leaks.length === 0, leaks.join('; '));
    }
    const search = await call('GET', '/api/search?q=Sweep', { headers: ben.headers });
    check('existence', "search never returns another person's note", search.status === 200 && !search.text.includes(doc.id), search.text.slice(0, 200));
    const listed = await call('GET', '/api/docs', { headers: ben.headers });
    check('existence', "the doc list never returns another person's note", listed.status === 200 && !listed.text.includes(doc.id));

    // ---- the origin gate (A§18)
    const gate = [];
    for (const origin of [undefined, 'https://evil.example', 'null', otherPortOrigin(base)]) {
      const response = await call('POST', '/api/docs', { headers: { cookie: ada.cookie, ...(origin ? { origin } : {}) }, body: {} });
      if (response.status !== 403) gate.push(`POST /api/docs with Origin ${origin}: ${response.status}`);
    }
    check('origin gate', 'a cookie without the app Origin cannot change state', gate.length === 0, gate.join('; '));
    check('origin gate', 'a cookie socket from another origin closes 4401', (await socket(docSocket(doc.id), { cookie: ada.cookie, origin: 'https://evil.example' })) === 'close 4401');

    // ---- token threading: a viewer link reaches every read of its doc, header or query, and nothing more
    // Comments are for signed-in readers only (comments.ts): a link holder signs in to read them.
    const reads = ['', '/content', '/assets/sweep.svg', '/access'];
    const threaded = [];
    for (const suffix of reads) {
      const byQuery = await call('GET', `/api/docs/${doc.id}${suffix}${suffix.includes('?') ? '&' : '?'}share=${link}`);
      const byHeader = await call('GET', `/api/docs/${doc.id}${suffix}`, { headers: { 'x-moss-share': link } });
      if (byQuery.status !== 200 || byHeader.status !== 200) threaded.push(`${suffix || '/'}: ${byQuery.status}/${byHeader.status}`);
    }
    const signedInComments = await call('GET', `/api/docs/${doc.id}/comments?share=${link}`, { headers: ben.headers });
    if (signedInComments.status !== 200) threaded.push(`signed-in /comments: ${signedInComments.status}`);
    check('tokens', 'a viewer link reads the note, its content, media and role by query or header, and comments once signed in', threaded.length === 0, threaded.join('; '));
    check('tokens', "a viewer link's socket is admitted", (await socket(docSocket(doc.id, `&share=${link}`))) === 'open');
    const linkWrites = [];
    for (const [method, suffix, body] of [['PATCH', '', { title: 'pwned' }], ['POST', '/comments', { body: 'x' }], ['POST', '/push', { newText: 'x', baseHash: '0'.repeat(64) }], ['GET', '/members'], ['GET', '/links'], ['DELETE', ''], ['POST', '/assets/from-url', { url: 'https://example.com/a.png' }]]) {
      const response = await call(method, `/api/docs/${doc.id}${suffix}?share=${link}`, { body });
      if (response.status < 400) linkWrites.push(`${method} ${suffix || '/'}: ${response.status}`);
    }
    for (const [method, suffix, body] of [['PATCH', '', { title: 'pwned' }], ['POST', '/comments', { body: 'x' }], ['DELETE', ''], ['POST', '/links', { role: 'editor' }]]) {
      const response = await call(method, `/api/docs/${doc.id}${suffix}?share=${link}`, { headers: write(ben), body });
      if (response.status < 400) linkWrites.push(`signed in ${method} ${suffix || '/'}: ${response.status}`);
    }
    check('tokens', 'a viewer link, signed out or in, writes nothing and sees no members or links', linkWrites.length === 0, linkWrites.join('; '));
    const titleAfter = (await call('GET', `/api/docs/${doc.id}`, { headers: ada.headers })).json?.doc?.title;
    check('tokens', 'the note was not renamed by any refused write', titleAfter !== 'pwned', titleAfter);

    // Revoking the link: every path answers as a forged token does, and its socket closes.
    const linkSocket = socket(docSocket(doc.id, `&share=${link}`));
    const revoked = await call('DELETE', `/api/docs/${doc.id}/links/${link}`, { headers: write(ada) });
    check('revocation', 'the owner revokes the link', revoked.status === 200, `${revoked.status} ${revoked.text.slice(0, 120)}`);
    const dead = [];
    for (const suffix of reads) {
      const was = await call('GET', `/api/docs/${doc.id}${suffix}?share=${link}`);
      const fake = await call('GET', `/api/docs/${doc.id}${suffix}?share=${forged}`);
      if (was.status < 400 || !same(was, fake)) dead.push(`${suffix || '/'}: ${was.status}`);
    }
    check('revocation', 'a revoked link answers exactly as a forged one on every read', dead.length === 0, dead.join('; '));
    check('revocation', 'a revoked link cannot open a socket (4404)', (await socket(docSocket(doc.id, `&share=${link}`))) === 'close 4404');
    check('revocation', 'a socket open on the link closes when it is revoked', /^close 44\d\d$|^ended$/.test(await linkSocket), await linkSocket);

    // Agent keys: the key acts for its owner up to editor, administers nothing, and stops at revocation.
    const key = bearer(agentKey);
    check('tokens', "an agent key reads its owner's note", (await call('GET', `/api/docs/${doc.id}`, key)).status === 200);
    check('tokens', 'an agent key cannot mint agents or manage links', (await call('POST', '/api/agents', { ...key, body: { name: 'x' } })).status === 403
      && (await call('POST', `/api/docs/${doc.id}/links`, { ...key, body: { role: 'viewer' } })).status === 403);
    const agentId = agent.json.agent.id;
    const agentSocket = socket(docSocket(doc.id), { authorization: `Bearer ${agentKey}` });
    await new Promise((r) => setTimeout(r, 500));
    const revokedKey = await call('DELETE', `/api/agents/${agentId}`, { headers: write(ada) });
    check('revocation', 'the owner revokes the agent key', revokedKey.status === 200, `${revokedKey.status}`);
    check('revocation', 'a revoked agent key is a 401 everywhere', (await call('GET', '/api/me', key)).status === 401 && (await call('GET', `/api/docs/${doc.id}`, key)).status === 401);
    check('revocation', "a revoked key's open socket closes", /^close 44\d\d$|^ended$/.test(await agentSocket), await agentSocket);
    check('revocation', 'a revoked agent key cannot open a socket (4401)', (await socket(docSocket(doc.id), { authorization: `Bearer ${agentKey}` })) === 'close 4401');

    // Sign-out ends the session for its cookie, its bearer form and its sockets.
    const grant = await call('POST', `/api/docs/${doc.id}/members`, { headers: write(ada), body: { email: cy.email, role: 'viewer' } });
    check('setup', 'the owner shares with cy', grant.status < 300, `${grant.status} ${grant.text.slice(0, 120)}`);
    const cySocket = socket('/api/workspace/ws', { cookie: cy.cookie, origin: base });
    await new Promise((r) => setTimeout(r, 500));
    const out = await call('POST', '/api/auth/sign-out', { headers: write(cy), body: {} });
    check('sign-out', 'sign-out answers 200', out.status === 200, `${out.status}`);
    check('sign-out', "the signed-out session's cookie and bearer are a 401", (await call('GET', '/api/me', { headers: cy.headers })).status === 401
      && (await call('GET', '/api/me', bearer(cy.token))).status === 401);
    check('sign-out', "the signed-out session's workspace socket closes", /^close 44\d\d$|^ended$/.test(await cySocket), await cySocket);
    check('sign-out', 'the signed-out cookie cannot open a socket (4401)', (await socket(docSocket(doc.id), { cookie: cy.cookie, origin: base })) === 'close 4401');

    // ---- SSRF: every internal target is refused before any fetch, on both fetch paths
    const ssrf = [];
    for (const url of SSRF_URLS) {
      const unfurl = await call('POST', '/api/unfurl', { headers: write(ada), body: { noteId: doc.id, url } });
      if (unfurl.status !== 422) ssrf.push(`unfurl ${url}: ${unfurl.status}`);
      const image = await call('POST', `/api/docs/${doc.id}/assets/from-url`, { headers: write(ada), body: { url } });
      if (image.status !== 422) ssrf.push(`from-url ${url}: ${image.status}`);
    }
    check('ssrf', `${SSRF_URLS.length} internal or non-https targets are refused 422 by unfurl and from-url`, ssrf.length === 0, ssrf.join('; '));
    check('ssrf', 'nothing ever stored a refused image', !(await call('GET', `/api/docs/${doc.id}/assets/a.png`, { headers: ada.headers })).status.toString().startsWith('2'));

    if (!limits) return results;

    // ---- body caps: an oversized JSON body is refused 413 before it is read, signed in or not
    const capped = [];
    const how = edge ? 'once the edge has the whole body' : 'from its Content-Length';
    for (const [path, headers] of [['/api/unfurl', {}], ['/api/unfurl', write(ada)], ['/api/feedback', write(ada)], [`/api/docs/${doc.id}/comments`, write(ada)], ['/api/auth/sign-in/email', { origin: base }]]) {
      const status = await oversized('POST', path, { ...headers, 'content-type': 'application/json' }, 64 * 1024 * 1024);
      if (status !== 413) capped.push(`${path}: ${status}`);
    }
    check('limits', `a 64 MiB JSON body is refused 413 ${how} on /api and /api/auth`, capped.length === 0, capped.join('; '));
    const over = Buffer.from(JSON.stringify({ pad: 'x'.repeat(JSON_BODY_CAP) }));
    const streamed = await oversized('POST', '/api/unfurl', { 'content-type': 'application/json' }, over.byteLength, over);
    check('limits', `a JSON body just over ${JSON_BODY_CAP} bytes is a 413`, streamed === 413, `${streamed}`);
    const huge = await oversized('POST', `/api/docs/${doc.id}/assets?filename=big.png`, { ...write(ada), 'content-type': 'image/png' }, 10 * 1024 * 1024 + 1);
    check('limits', `an image over 10 MB is refused 413 ${how}`, huge === 413, `${huge}`);

    // ---- rate limits: each answers 429 past its window
    const until429 = async (max, send) => {
      for (let i = 1; i <= max; i += 1) {
        const response = await send(i);
        if (response.status === 429) return i;
      }
      return null;
    };
    const fetches = await until429(40, () => call('POST', '/api/unfurl', { headers: write(ada), body: { noteId: doc.id, url: `https://sweep-${randomBytes(4).toString('hex')}.example.invalid/` } }));
    check('limits', 'remote fetches (unfurl) are throttled 429 within 31', fetches !== null && fetches <= 31, `429 at ${fetches}`);
    const comments = await until429(70, (i) => call('POST', `/api/docs/${doc.id}/comments`, { headers: write(ada), body: { id: `sweep-c${i}`, text: `c${i}`, parentId: 'sweep-c0' } }));
    check('limits', 'comment operations are throttled 429 within 61 (the setup comment counts)', comments !== null && comments <= 61, `429 at ${comments}`);
    const renames = await until429(70, (i) => call('PATCH', `/api/docs/${doc.id}`, { headers: write(ada), body: { title: `Sweep ${i}` } }));
    check('limits', 'REST writes (renames) are throttled 429 within 61', renames !== null && renames <= 61, `429 at ${renames}`);
    // Off loopback each attempt claims a new client IP; the limit keys on the edge's cf-connecting-ip, so the window
    // must still close. (The edge itself refuses a client-sent cf-connecting-ip with 403.)
    const spoofed = (i) => (edge ? { 'x-forwarded-for': `198.51.100.${i}`, 'x-real-ip': `198.51.100.${i}` } : {});
    const signIns = await until429(15, (i) => call('POST', '/api/auth/sign-in/email', { headers: { origin: base, ...spoofed(i) }, body: { email: ada.email, password: 'wrong-password-123' } }));
    check('limits', `sign-in is throttled 429 within 11${edge ? ', whatever client IP each attempt claims' : ''}`, signIns !== null && signIns <= 11, `429 at ${signIns}`);
    const signUps = await until429(15, () => call('POST', '/api/auth/sign-up/email', { headers: { origin: base }, body: { email: 'not-an-email', password: 'x', name: 'x' } }));
    check('limits', 'sign-up is throttled 429 within 11 (the three sweep sign-ups count)', signUps !== null && signUps <= 11, `429 at ${signUps}`);
    return results;
  }

  return { run, results, check, socket, docSocket, call };
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const [key, inline] = argv[i].replace(/^--/, '').split('=');
    opts[key] = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : true);
  }
  return opts;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const opts = parseArgs(process.argv.slice(2));
  if (typeof opts['base-url'] !== 'string') {
    console.error('usage: node scripts/security/sweep.mjs --base-url URL [--json] [--skip-limits]');
    process.exit(2);
  }
  const sweep = createSweep(opts['base-url']);
  try {
    await sweep.run({ limits: !opts['skip-limits'] });
  } catch (error) {
    sweep.check('sweep', 'the sweep ran to the end', false, error instanceof Error ? error.stack ?? error.message : String(error));
  }
  const failed = sweep.results.filter((r) => !r.ok);
  if (opts.json) console.log(JSON.stringify(sweep.results, null, 2));
  else {
    for (const r of sweep.results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  [${r.area}] ${r.name}${r.ok || !r.detail ? '' : `\n      ${r.detail}`}`);
    console.log(`\n${sweep.results.length - failed.length}/${sweep.results.length} checks passed`);
  }
  process.exit(failed.length ? 1 : 0);
}

export { comparable };

import { describe, expect, it } from 'vitest';
import { credentialLinesIn, isForbidden, NPMRC_CREDENTIAL, URL_CREDENTIAL } from '../lib/tracked-files.mjs';

/**
 * The tests that should have existed before any of this shipped.
 *
 * The `.npmrc` credential rule missed a real secret key in two consecutive reviews: first `key`,
 * which holds an inline PEM private key rather than a path, then `password`, which holds a
 * plaintext password while its underscore sibling `_password` was caught all along. Both survived
 * for the same reason, and it was not cleverness on their part: nothing tested this. The rule lived
 * inside a script that calls `main()` at import, so no test could reach it without running the
 * gate, and a security predicate pinned by nothing drifts.
 *
 * So both directions are enumerated here. A miss leaks a credential into a public repository, and a
 * false positive fails the build for everyone until somebody deletes the rule, which is the same
 * outcome one step later.
 */

/** Lines that MUST fail the build. Each names why it is not obvious. */
const MUST_CATCH = [
  ['//registry.npmjs.org/:_authToken=npm_aaaaaaaaaaaaaaaaaaaa', 'the canonical shape'],
  ['_auth=aGVsbG86d29ybGQ=', 'basic auth, base64, no scope prefix'],
  ['_authToken=npm_bbbbbbbbbbbbbbbbbbbb', 'bare token'],
  ['_auth_token=npm_cccccccccccccccccccc', 'the underscored spelling'],
  ['_password=hunter2', 'underscored password'],
  ['_secret=shhh', 'underscored secret'],
  ['password=hunter2plaintext', 'NO underscore, and npm treats it as a real secret'],
  ['key="-----BEGIN PRIVATE KEY-----\\nMIIEvQ\\n-----END PRIVATE KEY-----"', 'an INLINE PEM private key, not a path'],
  ['cert="-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----"', 'the inline certificate beside it'],
  ['//npm.internal.example/:_password=hunter2', 'scoped to a registry'],
  ['//npm.internal.example/:key=inline-pem', 'scoped, bare family'],
  ['  \t_authToken=npm_dddddddddddddddddddd', 'leading whitespace and a tab'],
  ['_AUTHTOKEN=npm_eeeeeeeeeeeeeeeeeeee', 'uppercase'],
  ['PASSWORD=hunter2', 'uppercase bare family'],
  ['_authToken =npm_ffffffffffffffffffff', 'space before the equals'],
  ['# //registry.npmjs.org/:_authToken=npm_gggggggggggggggggggg', 'commented out, and still committed'],
  ['; password=hunter2', 'the other comment character'],
  ['#password=hunter2', 'commented with no space'],
  ['registry=https://ci-user:s3cr3t@npm.internal.example/', 'a credential inside a URL, no key name at all'],
  ['//npm.internal.example/:registry=http://u:p@host/', 'URL credential, scoped'],
];

/** Lines that must NOT fail the build. A false positive here breaks every build. */
const MUST_NOT_CATCH = [
  'min-release-age=3',
  'registry=https://registry.npmjs.org/',
  'registry=https://npm.internal.example/path/to/thing',
  '@scope:registry=https://npm.pkg.github.com/',
  'keyfile=C:/certs/client.key',
  'certfile=C:/certs/client.crt',
  'cafile=/etc/ssl/certs/ca.pem',
  'key-something=value',
  'monkey=business',
  'passwords=see-the-vault',
  'password-store=1password',
  'password_file=/run/secrets/npm',
  'passwd=nope',
  'certificate-authority-file=/etc/ssl/ca.pem',
  'user-agent=npm/11.14.1 node/v22.22.0',
  'cache=C:/Users/someone/AppData/Local/npm-cache',
  'save-exact=true',
  'engine-strict=false',
  'fund=false',
  'audit-level=high',
  '# nothing secret in this comment at all',
  '; also nothing here',
  '',
  '   ',
  'legacy-peer-deps=false',
  'prefix=C:/Users/someone/AppData/Roaming/npm',
  'init-author-name=Someone',
  'init-license=MIT',
  'strict-ssl=true',
  'proxy=http://proxy.internal.example:8080/',
  'https-proxy=https://proxy.internal.example:8443/',
  'noproxy=localhost,127.0.0.1',
];

describe('the .npmrc secret rule', () => {
  for (const [line, why] of MUST_CATCH) {
    it(`catches ${why}`, () => {
      expect(credentialLinesIn(line)).toEqual([1]);
    });
  }

  for (const line of MUST_NOT_CATCH) {
    it(`leaves alone: ${JSON.stringify(line)}`, () => {
      expect(credentialLinesIn(line)).toEqual([]);
    });
  }

  it('reports every offending line by its 1-based number', () => {
    const file = [
      '# a comment',
      'min-release-age=3',
      '_authToken=npm_hhhhhhhhhhhhhhhhhhhh',
      'registry=https://registry.npmjs.org/',
      'password=hunter2',
    ].join('\n');
    expect(credentialLinesIn(file)).toEqual([3, 5]);
  });

  it('reads CRLF files without missing the last field of a line', () => {
    expect(credentialLinesIn('min-release-age=3\r\npassword=hunter2\r\n')).toEqual([2]);
  });

  it('keeps the two rules independent, so neither is doing the other\'s job', () => {
    // If one of these ever matched both corpora, deleting the other would go unnoticed.
    expect(NPMRC_CREDENTIAL.test('password=hunter2')).toBe(true);
    expect(URL_CREDENTIAL.test('password=hunter2')).toBe(false);
    expect(URL_CREDENTIAL.test('registry=https://u:p@host/')).toBe(true);
    expect(NPMRC_CREDENTIAL.test('registry=https://u:p@host/')).toBe(false);
  });

  it('does not carry regex state between calls', () => {
    // A /g flag on either rule would make `test` stateful and every second call would lie. Neither
    // has one today, and this is what notices if one is added.
    expect(credentialLinesIn('password=a\npassword=b\npassword=c')).toEqual([1, 2, 3]);
  });
});

describe('forbidden tracked paths', () => {
  const FORBIDDEN = [
    '.claude/settings.json',
    'packages/memory/.claude/settings.json',
    '.planning/ROADMAP.md',
    'apps/api/.crash-buffers/cb-1.md',
    'CLAUDE.md',
    'apps/web/AGENTS.md',
    'HUMAN-TODO.md',
    '.build-lane',
    'design/_scratch/idea.png',
    '.env',
    '.env.production',
    'apps/api/.env',
    'secrets/prod.env',
  ];

  const ALLOWED = [
    '.env.example',
    '.env.sample',
    '.env.template',
    'README.md',
    'docs/gates.md',
    'packages/memory/src/index.ts',
    '.npmrc',
    '.gitattributes',
    'design/mockups/board.css',
    'scripts/lib/tracked-files.mjs',
  ];

  for (const candidate of FORBIDDEN) {
    it(`refuses ${candidate}`, () => expect(isForbidden(candidate)).toBe(true));
  }
  for (const candidate of ALLOWED) {
    it(`permits ${candidate}`, () => expect(isForbidden(candidate)).toBe(false));
  }

  it('matches at any depth, which is where a second copy actually turns up', () => {
    expect(isForbidden('a/b/c/d/e/.claude/settings.json')).toBe(true);
    expect(isForbidden('a/b/c/d/e/.env')).toBe(true);
  });

  it('is case insensitive, because Windows is', () => {
    expect(isForbidden('Claude.md')).toBe(true);
    expect(isForbidden('packages/Memory/.CLAUDE/x.json')).toBe(true);
  });
});

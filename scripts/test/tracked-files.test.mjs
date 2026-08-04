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

/**
 * The stand-in value in every fixture below, and the reason it reads like a notice rather than
 * like a secret.
 *
 * GitGuardian failed this pull request on two of these lines: a Basic Auth String and a Generic
 * Password. It was RIGHT to. A `user:password@host` string in committed source is exactly what a
 * secret scanner should stop, and the fact that this particular one is a fixture is something only
 * a reader knows. The tempting responses were both wrong. Excluding this path from scanning would
 * also hide a real secret pasted here later. Splitting the literal to defeat the detector is the
 * same evasion wearing a lab coat, in a repository whose whole argument is that you do not route
 * around a security control because you are confident.
 *
 * So the values changed instead. Explaining why that is safe took five attempts and four of them
 * were wrong, always in the same way: describing the regexes as though reading them told you what
 * they do. `NPMRC_CREDENTIAL` does stop at the equals and `URL_CREDENTIAL` does discriminate on the
 * value, but stating it that way is the wrong axis, and stating it that way is what hid two real
 * gaps. See the header of `../lib/tracked-files.mjs`: neither rule is a parser, both approximate
 * npm's ini syntax, and the differences are where the leaks live.
 *
 * What matters for THIS file is narrower and does not depend on that at all. No fixture value below
 * participates in any match, which the corpus proves in both directions rather than asserting. So a
 * placeholder exercises the identical branch, and if a future fixture has to look like a real
 * credential to test something, that is a signal about the rule rather than about the fixture.
 */
const NOT_A_SECRET = 'example-value-that-is-not-a-secret';

/** Lines that MUST fail the build. Each names why it is not obvious. */
const MUST_CATCH = [
  [`//registry.npmjs.org/:_authToken=${NOT_A_SECRET}`, 'the canonical shape'],
  [`_auth=${NOT_A_SECRET}`, 'basic auth, no scope prefix'],
  [`_authToken=${NOT_A_SECRET}`, 'bare token'],
  [`_auth_token=${NOT_A_SECRET}`, 'the underscored spelling'],
  [`_password=${NOT_A_SECRET}`, 'underscored password'],
  [`_secret=${NOT_A_SECRET}`, 'underscored secret'],
  [`password=${NOT_A_SECRET}`, 'NO underscore, and npm treats it as a real secret'],
  ['key="-----BEGIN PRIVATE KEY-----\\nEXAMPLE-ONLY\\n-----END PRIVATE KEY-----"', 'an INLINE PEM private key, not a path'],
  ['cert="-----BEGIN CERTIFICATE-----\\nEXAMPLE-ONLY\\n-----END CERTIFICATE-----"', 'the inline certificate beside it'],
  [`//npm.internal.example/:_password=${NOT_A_SECRET}`, 'scoped to a registry'],
  ['//npm.internal.example/:key=inline-pem-placeholder', 'scoped, bare family'],
  [`  \t_authToken=${NOT_A_SECRET}`, 'leading whitespace and a tab'],
  [`_AUTHTOKEN=${NOT_A_SECRET}`, 'uppercase'],
  [`PASSWORD=${NOT_A_SECRET}`, 'uppercase bare family'],
  [`_authToken =${NOT_A_SECRET}`, 'space before the equals'],
  [`# //registry.npmjs.org/:_authToken=${NOT_A_SECRET}`, 'commented out, and still committed'],
  [`; password=${NOT_A_SECRET}`, 'the other comment character'],
  [`#password=${NOT_A_SECRET}`, 'commented with no space'],
  [
    `registry=https://example-user:${NOT_A_SECRET}@npm.internal.example/`,
    'a credential inside a URL, no key name at all',
  ],
  ['//npm.internal.example/:registry=http://u:p@host/', 'URL credential, scoped, minimal form'],
  [
    `registry = https://example-user:${NOT_A_SECRET}@npm.internal.example/`,
    'SPACES around the equals, which npm accepts and this rule used to miss entirely',
  ],
  [
    `registry\t=\thttps://example-user:${NOT_A_SECRET}@npm.internal.example/`,
    'tabs around the equals, the same hole',
  ],
  [
    `//npm.internal.example/:registry = http://example-user:${NOT_A_SECRET}@host/`,
    'spaced AND scoped, which the commit message once claimed a fixture for and did not have',
  ],
  [
    `# registry = https://example-user:${NOT_A_SECRET}@npm.internal.example/`,
    'spaced AND commented, same',
  ],
  [
    `registry = "https://example-user:${NOT_A_SECRET}@npm.internal.example/"`,
    'a QUOTED value: npm config list prints this form, so pasting npm output produced a shape the gate could not see',
  ],
  [
    `"registry" = https://example-user:${NOT_A_SECRET}@npm.internal.example/`,
    'a QUOTED key, which npm resolves identically and both rules used to miss',
  ],
  [
    `## registry = https://example-user:${NOT_A_SECRET}@npm.internal.example/`,
    'a doubled comment marker, which defeated both rules',
  ],
  [
    `registry[] = https://example-user:${NOT_A_SECRET}@npm.internal.example/`,
    'ini array syntax on the key',
  ],
  [`"password" = ${NOT_A_SECRET}`, 'quoted key on the other rule too'],
  [`## password = ${NOT_A_SECRET}`, 'doubled comment marker on the other rule too'],
  [
    `registry = https://:${NOT_A_SECRET}@npm.internal.example/`,
    'EMPTY USERNAME, which is the canonical way to put a bare token in a registry URL and was the likeliest real leak of all',
  ],
  [
    `registry=https://:${NOT_A_SECRET}@npm.internal.example/`,
    'empty username, unspaced',
  ],
  [
    `//npm.internal.example/:registry = https://:${NOT_A_SECRET}@host/`,
    'empty username, scoped',
  ],
  [
    `registry = git+https://example-user:${NOT_A_SECRET}@host/repo.git`,
    'a scheme containing a plus, which npm accepts and the old scheme pattern could not match',
  ],
  [
    `registry = git+ssh://example-user:${NOT_A_SECRET}@host/repo.git`,
    'the other plus scheme',
  ],
];

/** Lines that must NOT fail the build. A false positive here breaks every build. */
const MUST_NOT_CATCH = [
  'min-release-age=3',
  'min-release-age = 3',
  'registry=https://registry.npmjs.org/',
  'registry = https://registry.npmjs.org/',
  'registry = https://npm.internal.example/path/with:colon/but/no/at/sign',
  'registry = "https://registry.npmjs.org/"',
  '"registry" = "https://registry.npmjs.org/"',
  'init-author-email = someone@example.com',
  'proxy = http://proxy.internal.example:8080/',
  '@scope:registry = https://npm.pkg.github.com/@scope/pkg',
  'registry = https://host/x?u=a:b@c',
  'registry = https://user@host/',
  'registry = git+https://host/repo.git',
  'registry = git+ssh://host/repo.git',
  'registry = https://host:8443/path',
  'registry = https://host/a:b',
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

  it('scans comment lines on purpose, whatever the marker', () => {
    // Not because npm resolves them. npm's ini skips any line starting `#` or `;`, single or
    // doubled, so these configure nothing. They are scanned because a commented-out token is still
    // a committed token: the marker stops npm and does not stop whoever reads the repository.
    for (const marker of ['#', '##', ';', ';;', '# ', '## ']) {
      expect(credentialLinesIn(`${marker}password=${NOT_A_SECRET}`)).toEqual([1]);
    }
  });

  it('does not fire on prose in a comment that merely mentions a secret key', () => {
    // This repository's own .npmrc is mostly prose comments, so the cost of getting this wrong is
    // paid every build. A sentence ABOUT a key is not an assignment OF one.
    for (const line of [
      '# the password lives in the vault, not here',
      '## do not put a key in this file',
      '; see docs/gates.md for why _authToken is refused',
      '# key rotation is handled by the owner',
    ]) {
      expect(credentialLinesIn(line)).toEqual([]);
    }
  });

  it('does NOT cover an empty key, which is a known and deliberate divergence', () => {
    // ` = https://user:token@host/` parses to the key "" and resolves in npm. The key pattern is
    // `+` rather than `*` because a NULLABLE key lets the leading whitespace and the whitespace
    // before the equals share one run of spaces, backtracking quadratically: 37 seconds at 200k
    // characters. The `+` works by making the key unable to match empty, not by bounding it. This
    // test exists so the divergence is a recorded decision rather than a surprise, and so that
    // anyone who closes it has to delete a test that says why it is open.
    expect(credentialLinesIn(` = https://u:p@host/`)).toEqual([]);
    expect(credentialLinesIn(`  = ${NOT_A_SECRET}`)).toEqual([]);
  });

  it('does NOT cover a key containing whitespace, the other known divergence', () => {
    expect(credentialLinesIn('my key = https://u:p@host/')).toEqual([]);
  });

  it('stays fast on pathological lines, which nothing pinned until it nearly bit', () => {
    // WHY THE INPUTS ARE SMALL, which is the whole design of this test.
    //
    // The measurement happens AFTER the call returns, so a catastrophic regression does not fail
    // here, it HANGS: a synchronous regex blocks the thread, which blocks vitest's own timeout too.
    // Proven the hard way. Planting the trap described in lib/tracked-files.mjs (adding \s to the
    // key class) and running this file with 200,000 character inputs ran past TEN MINUTES before it
    // was killed, against a documented estimate of 138 seconds. A guard that only reports after
    // paying the cost has to pick inputs where the cost is affordable.
    //
    // So the sizes are chosen to make a regression fail in under a second while healthy code stays
    // in microseconds. Measured reference points for the two regressions this is aimed at: the
    // nullable-key version costs about 178 ms at 16,000 characters, and the whitespace-in-key
    // version is cubic and costs about 0.3 seconds at 1,000. Both trip a 100 ms ceiling almost
    // immediately, and the healthy margin is still four orders of magnitude.
    const sizes = [1_000, 4_000, 16_000];
    for (const size of sizes) {
      const pathological = [
        ' '.repeat(size),
        `registry${' '.repeat(size)}x`,
        `registry = ${'#'.repeat(size)}`,
        `registry=https://${':'.repeat(size)}x`,
        `${'a'.repeat(size)}x`,
      ];
      for (const line of pathological) {
        const startedAt = performance.now();
        credentialLinesIn(line);
        expect(performance.now() - startedAt).toBeLessThan(100);
      }
    }
  });

  it('reports every offending line by its 1-based number', () => {
    const file = [
      '# a comment',
      'min-release-age=3',
      `_authToken=${NOT_A_SECRET}`,
      'registry=https://registry.npmjs.org/',
      `password=${NOT_A_SECRET}`,
    ].join('\n');
    expect(credentialLinesIn(file)).toEqual([3, 5]);
  });

  it('reads CRLF files without missing the last field of a line', () => {
    expect(credentialLinesIn(`min-release-age=3\r\npassword=${NOT_A_SECRET}\r\n`)).toEqual([2]);
  });

  it('keeps the two rules independent, so neither is doing the other\'s job', () => {
    // If one of these ever matched both corpora, deleting the other would go unnoticed.
    expect(NPMRC_CREDENTIAL.test(`password=${NOT_A_SECRET}`)).toBe(true);
    expect(URL_CREDENTIAL.test(`password=${NOT_A_SECRET}`)).toBe(false);
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

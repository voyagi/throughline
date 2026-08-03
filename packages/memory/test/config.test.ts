import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  describeTarget,
  loadDatabaseConfig,
  redact,
  secretsOf,
} from '../src/config.ts';

const PASSWORD = 'sup3r-s3cret-rotated-password';
const URL_WITH_SECRET = `postgresql://throughline:${PASSWORD}@cluster.example.cloud:26257/defaultdb?sslmode=verify-full`;

describe('loadDatabaseConfig', () => {
  it('accepts a real connection string and fills in the defaults', () => {
    const config = loadDatabaseConfig({ DATABASE_URL: URL_WITH_SECRET });
    expect(config.connectionString).toBe(URL_WITH_SECRET);
    expect(config.schema).toBe('throughline');
    expect(config.statementTimeoutMs).toBeGreaterThan(0);
    expect(config.maxConnections).toBeGreaterThan(0);
  });

  it('accepts both postgres and postgresql schemes', () => {
    expect(() => loadDatabaseConfig({ DATABASE_URL: 'postgres://h/db' })).not.toThrow();
    expect(() => loadDatabaseConfig({ DATABASE_URL: 'postgresql://h/db' })).not.toThrow();
  });

  it.each([
    ['missing', {}],
    ['empty', { DATABASE_URL: '' }],
    ['not a postgres url', { DATABASE_URL: 'mysql://host/db' }],
  ])('rejects a %s DATABASE_URL', (_label, env) => {
    expect(() => loadDatabaseConfig(env)).toThrow(ConfigError);
  });

  it('never puts the connection string into the validation error', () => {
    // A validation error that echoes its input is the classic way a password reaches a CI log.
    // The failing value here is itself the credential, so this is not a hypothetical.
    try {
      loadDatabaseConfig({ DATABASE_URL: `mysql://user:${PASSWORD}@host/db` });
      expect.unreachable('an invalid scheme must throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(PASSWORD);
      expect(message).not.toContain('mysql://');
      expect(message).toContain('DATABASE_URL');
    }
  });

  it('rejects a schema name that is not a bare identifier', () => {
    // The schema name is interpolated into a startup option string and into DDL, so it is one of
    // only two values in this codebase that reach SQL-adjacent text unparameterised.
    for (const bad of ['has space', 'has-dash', 'Uppercase', 'semi;colon', '1leading']) {
      expect(() => loadDatabaseConfig({ DATABASE_URL: 'postgres://h/db', THROUGHLINE_SCHEMA: bad })).toThrow(
        ConfigError,
      );
    }
  });

  it('accepts a legitimate alternative schema name', () => {
    const config = loadDatabaseConfig({
      DATABASE_URL: 'postgres://h/db',
      THROUGHLINE_SCHEMA: 'throughline_staging',
    });
    expect(config.schema).toBe('throughline_staging');
  });

  it('rejects a nonsensical connection ceiling rather than accepting it', () => {
    expect(() =>
      loadDatabaseConfig({ DATABASE_URL: 'postgres://h/db', THROUGHLINE_MAX_CONNECTIONS: '0' }),
    ).toThrow(ConfigError);
    expect(() =>
      loadDatabaseConfig({ DATABASE_URL: 'postgres://h/db', THROUGHLINE_MAX_CONNECTIONS: '500' }),
    ).toThrow(ConfigError);
  });
});

describe('redact', () => {
  it('removes a secret wherever it appears', () => {
    const text = `connection to ${URL_WITH_SECRET} failed`;
    expect(redact(text, [URL_WITH_SECRET])).not.toContain(PASSWORD);
    expect(redact(text, [URL_WITH_SECRET])).toContain('[redacted]');
  });

  it('removes every occurrence, not only the first', () => {
    const text = `${PASSWORD} and again ${PASSWORD}`;
    expect(redact(text, [PASSWORD])).toBe('[redacted] and again [redacted]');
  });

  it('ignores missing and very short secrets instead of shredding the message', () => {
    // A two character "secret" would replace unrelated text everywhere for no security benefit,
    // and an undefined one must not turn the whole message into markers.
    expect(redact('the db is down', [undefined, '', 'ab'])).toBe('the db is down');
  });
});

describe('secretsOf', () => {
  it('includes the password on its own, not only the whole url', () => {
    // A driver can report just the password, or a re-encoded url that a whole-string match misses.
    const config = loadDatabaseConfig({ DATABASE_URL: URL_WITH_SECRET });
    const secrets = secretsOf(config);
    expect(secrets).toContain(URL_WITH_SECRET);
    expect(secrets).toContain(PASSWORD);
    expect(redact(`auth failed for ${PASSWORD}`, secrets)).not.toContain(PASSWORD);
  });

  it('survives a connection string the URL parser cannot read', () => {
    const config = loadDatabaseConfig({ DATABASE_URL: 'postgres://' });
    expect(() => secretsOf(config)).not.toThrow();
  });
});

describe('describeTarget', () => {
  it('names the host, port, database and schema and nothing else', () => {
    const config = loadDatabaseConfig({ DATABASE_URL: URL_WITH_SECRET });
    const description = describeTarget(config);
    expect(description).toContain('cluster.example.cloud');
    expect(description).toContain('26257');
    expect(description).toContain('defaultdb');
    expect(description).toContain('throughline');
    expect(description).not.toContain(PASSWORD);
    expect(description).not.toContain('throughline:');
  });

  it('does not throw on an unparseable connection string', () => {
    const config = loadDatabaseConfig({ DATABASE_URL: 'postgres://' });
    expect(() => describeTarget(config)).not.toThrow();
  });
});

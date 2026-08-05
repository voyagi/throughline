import type { SoftwareApplication, TechArticle, WebSite, WithContext } from 'schema-dts';

/**
 * Structured data, typed by `schema-dts` so a mistyped property is a build error.
 *
 * ONE HELPER RATHER THAN A BLOCK PER PAGE. Five hand-written JSON-LD literals would be five places
 * for the description to drift, and `gate:dup` would refuse them anyway.
 *
 * What is deliberately NOT claimed here: no `aggregateRating`, no `review`, no `offers`, no
 * `datePublished` on pages that have no publication date. Structured data is a machine-readable
 * claim about a real thing, and a site whose entire argument is that it does not assert what it
 * cannot support would be a poor place to start inventing schema properties for rich results.
 */

const APPLICATION_CATEGORY = 'DeveloperApplication';

export function siteSchema(site: string): WithContext<WebSite> {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Throughline',
    url: site,
    description:
      'An incident-response agent whose memory you can audit. Every recall returns a receipt, and ' +
      'a search that could not run answers UNKNOWN rather than empty.',
  };
}

export function applicationSchema(site: string): WithContext<SoftwareApplication> {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Throughline',
    url: site,
    applicationCategory: APPLICATION_CATEGORY,
    operatingSystem: 'Any',
    description:
      'An agent memory layer on CockroachDB with auditable recall: typed memories, deterministic ' +
      'scoring, coverage verdicts, and eviction that cannot eat the newest entry.',
    license: 'https://opensource.org/licenses/MIT',
    softwareRequirements: 'Node.js 22 or newer, CockroachDB',
  };
}

export function articleSchema(site: string, path: string, headline: string): WithContext<TechArticle> {
  return {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline,
    url: new URL(path, site).href,
    isPartOf: { '@type': 'WebSite', name: 'Throughline', url: site },
    proficiencyLevel: 'Expert',
  };
}

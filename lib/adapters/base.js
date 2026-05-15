/**
 * Base adapter contract. All data source adapters extend this class.
 *
 * Each adapter encapsulates:
 * - How to fetch HTML from the source
 * - How to parse matches and results from that HTML
 * - How to map source-specific fields to canonical schema
 */

export class BaseAdapter {
  get name() {
    throw new Error('Adapter must implement get name()');
  }

  get encoding() {
    return 'utf-8';
  }

  buildMatchesUrl(options = {}) {
    throw new Error('Adapter must implement buildMatchesUrl()');
  }

  buildResultsUrl(date) {
    throw new Error('Adapter must implement buildResultsUrl()');
  }

  get fetchHeaders() {
    return {};
  }

  parseMatches(html) {
    throw new Error('Adapter must implement parseMatches()');
  }

  parseResults(html) {
    throw new Error('Adapter must implement parseResults()');
  }

  transformMatch(rawRow) {
    throw new Error('Adapter must implement transformMatch()');
  }
}

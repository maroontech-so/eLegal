const test = require('node:test');
const assert = require('node:assert/strict');
const { extractDocumentMetadata, extractKenyaLawDocumentInfo, normalizeKenyaLawSearchResults } = require('../server');

test('extractDocumentMetadata prefers the first meaningful title heading', () => {
  const text = `THE CONSTITUTION OF KENYA

Arrangement of Sections

This Act is to be read together with...`;
  const result = extractDocumentMetadata(text, 'Constitution of Kenya Act.pdf');

  assert.equal(result.title, 'The Constitution of Kenya');
  assert.equal(result.label, 'Constitution of Kenya');
  assert.match(result.citation, /The Constitution of Kenya/i);
});

test('extractDocumentMetadata falls back to the filename when no title can be inferred', () => {
  const result = extractDocumentMetadata('   \n\n  \n\n', 'Unknown Act.pdf');

  assert.equal(result.title, 'Unknown Act');
  assert.equal(result.label, 'Unknown Act');
  assert.equal(result.citation, 'Unknown Act');
});

test('extractKenyaLawDocumentInfo extracts the page title and source download URL', () => {
  const html = `<!DOCTYPE html><html><head><title>Michael Kinuthia Muturi v Republic [2011] KECA 273 (KLR)</title></head><body><a href="/akn/ke/judgment/keca/2011/273/eng@2011-04-13/source">Download PDF</a></body></html>`;
  const result = extractKenyaLawDocumentInfo(html, 'https://kenyalaw.org/akn/ke/judgment/keca/2011/273/eng');

  assert.equal(result.title, 'Michael Kinuthia Muturi v Republic [2011] KECA 273 (KLR)');
  assert.equal(result.citation, 'Michael Kinuthia Muturi v Republic [2011] KECA 273 (KLR)');
  assert.equal(result.sourceUrl, 'https://kenyalaw.org/akn/ke/judgment/keca/2011/273/eng@2011-04-13/source');
});

test('normalizeKenyaLawSearchResults maps the official API payload into result objects', () => {
  const payload = {
    results: [{
      title: 'Attorney General v Okiya Omtatah Okoiti & another [2019] KECA 774 (KLR)',
      citation: 'Attorney General v Okiya Omtatah Okoiti & another [2019] KECA 774 (KLR)',
      expression_frbr_uri: '/akn/ke/judgment/keca/2019/774/eng@2019-05-10',
      _score: 206.10149
    }]
  };

  const result = normalizeKenyaLawSearchResults(payload)[0];

  assert.equal(result.title, 'Attorney General v Okiya Omtatah Okoiti & another [2019] KECA 774 (KLR)');
  assert.equal(result.label, 'Attorney General v Okiya Omtatah Okoiti & another [2019] KECA 774 (KLR)');
  assert.equal(result.url, 'https://kenyalaw.org/akn/ke/judgment/keca/2019/774/eng@2019-05-10');
  assert.equal(result.source, 'kenyalaw');
});

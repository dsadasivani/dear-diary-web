const baseUrl = process.argv[2];

if (!baseUrl) {
  console.error('Usage: node scripts/verify-web-deployment.mjs <base-url>');
  process.exit(2);
}

const request = async (url) => {
  const response = await fetch(url, {
    headers: {
      'cache-control': 'no-cache',
      'user-agent': 'dear-diary-staging-verifier/1.0',
    },
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return response;
};

const indexUrl = new URL('/', baseUrl);
const indexResponse = await request(indexUrl);
const indexContentType = indexResponse.headers.get('content-type') ?? '';
if (!indexContentType.toLowerCase().includes('text/html')) {
  throw new Error(
    `Expected HTML from ${indexUrl}; received ${indexContentType || 'no content type'}`,
  );
}

const html = await indexResponse.text();
const assetReferences = new Set();
const referencePattern = /(?:src|href)=["']([^"']+\.(?:css|js)(?:\?[^"']*)?)["']/gi;
for (const match of html.matchAll(referencePattern)) {
  assetReferences.add(match[1]);
}

if (assetReferences.size === 0) {
  throw new Error(`No JavaScript or CSS assets were found in ${indexUrl}`);
}

for (const reference of assetReferences) {
  const assetUrl = new URL(reference, indexUrl);
  const response = await request(assetUrl);
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  const pathname = assetUrl.pathname.toLowerCase();
  const valid = pathname.endsWith('.css')
    ? contentType.includes('text/css')
    : contentType.includes('javascript');

  if (!valid || contentType.includes('text/html')) {
    throw new Error(
      `${assetUrl} returned ${contentType || 'no content type'}; expected ${
        pathname.endsWith('.css') ? 'text/css' : 'JavaScript'
      }`,
    );
  }
}

console.log(`Verified ${assetReferences.size} deployed JavaScript/CSS assets at ${baseUrl}`);

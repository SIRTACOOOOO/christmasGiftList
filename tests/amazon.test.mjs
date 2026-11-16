// Tests for the Amazon / a.co link preview helpers. No internet needed.  Run: node --experimental-strip-types tests/amazon.test.mjs
import { isAmazonHost, asinFrom, titleFromSlug, looksBlocked, parseAmazon, amazonPreview, asinImage } from '../supabase/functions/preview/amazon.ts';
let pass = 0, fail = 0; const ok = (c, n) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
for (const h of ['a.co', 'amzn.to', 'www.amazon.com', 'amazon.co.uk', 'www.amazon.com.au', 'smile.amazon.de', 'amzn.eu', 'amzn.com']) ok(isAmazonHost(h), h + ' is Amazon');
for (const h of ['notamazon.com', 'amazon.com.evil.com', 'example.com', 'amazon.evil.co', 'xa.co']) ok(!isAmazonHost(h), h + ' is not Amazon');
const U = s => new URL(s);
ok(asinFrom(U('https://www.amazon.com/dp/B0C1234567')) === 'B0C1234567', 'asin from /dp/');
ok(asinFrom(U('https://www.amazon.com/Cool-Thing-Name/dp/b0c1234567/ref=sr_1_3?keywords=x')) === 'B0C1234567', 'asin from a long address (upper-cased)');
ok(asinFrom(U('https://www.amazon.co.uk/gp/product/B08ABCDEFG?th=1')) === 'B08ABCDEFG', 'asin from /gp/product/');
ok(asinFrom(U('https://www.amazon.com/gp/aw/d/B08ABCDEFG/')) === 'B08ABCDEFG', 'asin from the app share address');
ok(asinFrom(U('https://a.co/d/abcdefghij')) === null, 'a short link has no asin until it is resolved');
ok(asinFrom(U('https://example.com/dp/B0C1234567')) === null, 'only Amazon addresses count');
ok(titleFromSlug(U('https://www.amazon.com/Stanley-Quencher-FlowState-Tumbler-40oz/dp/B0C1234567/ref=x')) === 'Stanley Quencher FlowState Tumbler 40oz', 'name from the address');
ok(titleFromSlug(U('https://www.amazon.com/dp/B0C1234567')) === null, 'no name when the address has none');
ok(titleFromSlug(U('https://www.amazon.com/gp/product/B0C1234567')) === null, '"product" is not a name');
const page = `<html><head><title>Amazon.com: Stanley Quencher H2.0 FlowState Tumbler 40 oz : Home &amp; Kitchen</title><meta name="description" content="Buy Stanley Quencher: Tumbler"></head><body>
<span id="productTitle" class="a-size-large product-title-word-break">
   Stanley Quencher H2.0 FlowState Stainless Steel Vacuum Insulated Tumbler, Rose Quartz, 40oz
</span>
<div id="imgTagWrapperId"><img id="landingImage" data-old-hires="https://m.media-amazon.com/images/I/61abc._AC_SL1500_.jpg" data-a-dynamic-image="{&quot;https://m.media-amazon.com/images/I/61abc._AC_SX679_.jpg&quot;:[679,679]}" src="https://m.media-amazon.com/images/I/61abc._AC_SY355_.jpg"></div>
<span class="a-price a-text-price apexPriceToPay" data-a-size="b"><span class="a-offscreen">$1,035.50</span><span aria-hidden="true">x</span></span>
</body></html>`;
let r = parseAmazon(page, U('https://www.amazon.com/dp/B0C1234567'));
ok(r.title === 'Stanley Quencher H2.0 FlowState Stainless Steel Vacuum Insulated Tumbler, Rose Quartz, 40oz', 'title from productTitle');
ok(r.image === 'https://m.media-amazon.com/images/I/61abc._AC_SL1500_.jpg', 'big picture from data-old-hires');
ok(r.price === 1035.5, 'price from a-offscreen, thousands comma removed (' + r.price + ')');
ok(r.site === 'Amazon', 'site name');
r = parseAmazon(page.replace(/<span id="productTitle"[\s\S]*?<\/span>/, '').replace(/data-old-hires="[^"]+"/, ''), U('https://www.amazon.com/dp/B0C1234567'));
ok(r.title === 'Stanley Quencher H2.0 FlowState Tumbler 40 oz', 'title falls back to the page title without "Amazon.com:" and the category: ' + r.title);
ok(r.image === 'https://m.media-amazon.com/images/I/61abc._AC_SX679_.jpg', 'picture falls back to the dynamic-image list');
ok(looksBlocked('<title>Robot Check</title>') && looksBlocked('<p>Type the characters you see in this image:</p>') && looksBlocked('To discuss automated access to Amazon data please contact api-services-support@amazon.com') && !looksBlocked(page), 'robot-check pages are recognised');
const bigImg = () => new Response(new Uint8Array(9000), { status: 200, headers: { 'content-type': 'image/jpeg' } });
const tiny = () => new Response(new Uint8Array(43), { status: 200, headers: { 'content-type': 'image/gif' } });
ok(await asinImage('B0C1234567', async () => bigImg()) === 'https://m.media-amazon.com/images/P/B0C1234567.01._SCLZZZZZZZ_.jpg', 'picture by product number');
ok(await asinImage('B0C1234567', async () => tiny()) === null, 'the tiny "no picture" placeholder is ignored');
ok(await asinImage('B0C1234567', async () => { throw new Error('x'); }) === null, 'network trouble just means no picture');
// a real page
let a = await amazonPreview({ html: page, url: U('https://www.amazon.com/dp/B0C1234567'), ok: true }, U('https://a.co/d/xyz'), async () => bigImg());
ok(a && !a.partial && a.preview.price === 1035.5, 'a real product page gives a full preview');
// blocked by the robot check, but the redirect revealed a long address
a = await amazonPreview({ html: '<title>Robot Check</title>', url: U('https://www.amazon.com/Stanley-Quencher-Tumbler-40oz/dp/B0C1234567?ref_=cm_sw'), ok: true }, U('https://a.co/d/xyz'), async () => bigImg());
ok(a && a.partial && a.preview.title === 'Stanley Quencher Tumbler 40oz' && a.preview.image.includes('B0C1234567'), 'blocked: still a name and a picture from the address (a.co link)');
a = await amazonPreview({ html: 'Service Unavailable', url: U('https://www.amazon.com/Stanley-Quencher-Tumbler-40oz/dp/B0C1234567'), ok: false }, U('https://a.co/d/xyz'), async () => tiny());
ok(a && a.partial && a.preview.title && a.preview.image === null, 'blocked with a 503 and no picture: name only');
a = await amazonPreview({ html: '<title>Robot Check</title>', url: U('https://www.amazon.com/dp/B0C1234567'), ok: true }, U('https://a.co/d/xyz'), async () => tiny());
ok(a === null, 'nothing usable at all returns null (the app then says it could not read the page)');
a = await amazonPreview(null, U('https://a.co/d/xyz'), async () => bigImg());
ok(a === null, 'a short link that could not be followed returns null');
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

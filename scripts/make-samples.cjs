/* Regenerates the fictional sample materials in samples/ and the PDF test fixtures. Needs Playwright + Chromium:  node scripts/make-samples.cjs */
const { chromium } = require('playwright');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');
const css = `body{font-family:Georgia,serif;font-size:13pt;line-height:1.45;margin:0} h1{font-size:20pt;margin:0 0 8pt} h2{font-size:15pt;margin:14pt 0 4pt} p{margin:0 0 9pt} li{margin-bottom:4pt} .pb{page-break-after:always}`;
const doc = (body) => `<html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;

const algebra = doc(`
<div class="pb"><h1>Unit 3 Review: Absolute Value Inequalities</h1>
<p>Ms. Okafor’s Algebra 1 · Test on Friday · fictional practice packet</p>
<h2>Absolute value</h2>
<p>Absolute value: the distance of a number from zero on the number line, so it is never negative. For example |−4| = 4 and |4| = 4.</p>
<h2>Solving |x| &lt; a</h2>
<p>Absolute value less than a number: when |x| &lt; a with a &gt; 0, the solutions are all numbers closer to zero than a, so −a &lt; x &lt; a. This is an “and” statement: both inequalities must be true at once.</p>
<p>Example: |x − 3| &lt; 5 means −5 &lt; x − 3 &lt; 5. Add 3 to every part to get −2 &lt; x &lt; 8.</p>
<h2>Solving |x| &gt; a</h2>
<p>Absolute value greater than a number: when |x| &gt; a with a &gt; 0, the solutions are farther from zero than a, so x &lt; −a or x &gt; a. This is an “or” statement.</p>
<p>Example: |2x + 1| ≥ 7 means 2x + 1 ≤ −7 or 2x + 1 ≥ 7, so x ≤ −4 or x ≥ 3.</p></div>
<div class="pb"><h1>Page 2: Notation and special cases</h1>
<h2>Interval notation</h2>
<p>Interval notation: a way to write a set of solutions. Parentheses mean the endpoint is not included (&lt; or &gt;); square brackets mean it is included (≤ or ≥). The solution −2 &lt; x &lt; 8 is written (−2, 8). The solution x ≤ −4 or x ≥ 3 is written (−∞, −4] ∪ [3, ∞).</p>
<h2>Special cases</h2>
<ul><li>|x| &lt; −2 has no solution, because an absolute value can never be less than a negative number.</li>
<li>|x| &gt; −2 is true for every real number, because an absolute value is always at least 0.</li></ul>
<h2>Common mistakes</h2>
<ul><li>Writing |x| &gt; 3 as −3 &gt; x &gt; 3, which is impossible. It should be x &lt; −3 or x &gt; 3.</li>
<li>Forgetting to flip the inequality sign when multiplying or dividing by a negative number.</li>
<li>Not isolating the absolute value first: in 2|x| + 1 &lt; 9, subtract 1 and divide by 2 before splitting.</li></ul>
<p>Area connection: the area of a square with side x is x<sup>2</sup>, so x<sup>2</sup> &lt; 9 has the same solutions as |x| &lt; 3.</p></div>
<div><h1>Page 3: Practice problems (no answers given)</h1>
<ol><li>Solve |x + 2| &lt; 6 and write the answer in interval notation.</li><li>Solve |3x − 1| ≥ 8.</li><li>Solve 2|x| − 3 &lt; 7.</li><li>Explain why |x| &lt; −1 has no solutions.</li></ol></div>`);

const history = doc(`
<div class="pb"><h1>The Dust Bowl: Study Packet</h1>
<p>Mr. Reyes’s U.S. History · Unit 7 · fictional study packet. Be ready to explain causes, responses and results.</p>
<h2>What it was</h2>
<p>Dust Bowl: a period in the 1930s when severe drought and wind erosion turned farmland on the Southern Great Plains (parts of Oklahoma, Texas, Kansas, Colorado and New Mexico) into dust storms.</p>
<h2>Causes</h2>
<p>Great Plow-Up: during and after World War I, high wheat prices led farmers to plow up millions of acres of native prairie grass, whose deep roots had held the soil in place.</p>
<p>Drought: starting in 1931, years of far-below-average rainfall dried out the exposed soil, and strong winds lifted it into huge dust clouds.</p>
<p>Farming practices: farmers planted the same crop year after year and left fields bare after harvest, which left soil loose and easy to blow away.</p>
<p>Great Depression: crop prices collapsed, so many farmers could not pay loans and could not afford to change how they farmed.</p></div>
<div><h1>Page 2: Responses and results</h1>
<h2>Responses</h2>
<p>Soil Conservation Service: created in 1935 within the federal government to teach farmers methods that hold soil, such as contour plowing and crop rotation.</p>
<p>Shelterbelts: rows of trees planted across the Plains, starting in 1934, to slow the wind and protect fields.</p>
<p>Taylor Grazing Act: a 1934 law that regulated grazing on public land so grass could recover.</p>
<p>Black Sunday: on April 14, 1935, a huge dust storm swept the Plains and drew national attention to the crisis.</p>
<h2>Results</h2>
<p>Migration: hundreds of thousands of people left the Plains. Many families, nicknamed “Okies” even when they were not from Oklahoma, traveled to California looking for work.</p>
<p>Lasting farming changes: contour plowing, crop rotation and leaving crop residue on fields became common, and the federal government took a larger role in protecting farmland.</p>
<p>Cultural memory: John Steinbeck’s novel The Grapes of Wrath (1939) and the photographs of Dorothea Lange showed the human cost to the whole country.</p></div>`);

const english = doc(`
<div class="pb"><h1>Reading passage: “The Lantern Path”</h1>
<p>Grade 8 English · fictional passage for practice</p>
<p>Mara had counted the stairs to the lamp room a thousand times, but tonight she counted them aloud, as if the numbers might hold the tower up against the wind. Her father had gone down to the harbor at dusk to help a stranded boat, and the storm had arrived early.</p>
<p>“Keep the light turning,” he had told her, tying his coat. “Whatever else happens, keep it turning.” So when the old clockwork stuck halfway through the night, Mara did not run for help. She wedged her shoulder against the great brass gear and pushed, one slow quarter-turn at a time, until her arms shook and the beam swept the black water again.</p>
<p>At dawn her father found her asleep against the rail, her hands wrapped in torn sleeves. He did not praise her. He only looked at the sea, where the stranded boat rocked safely at anchor, and said quietly, “I saw the light the whole way.” Mara smiled without opening her eyes.</p></div>
<div><h1>Assignment and rubric</h1>
<p><strong>Prompt:</strong> Write one paragraph explaining how the author shows Mara’s character. Use at least two pieces of evidence from the passage.</p>
<h2>Rubric (4 points each)</h2>
<p>Claim: a strong answer states a clear claim about Mara’s character in the first sentence.</p>
<p>Evidence: a strong answer supports the claim with accurate quotations or close paraphrases from the passage.</p>
<p>Reasoning: a strong answer explains how each piece of evidence proves the claim, not just what happens.</p>
<p>Organization: a strong answer has a topic sentence, logical order, transitions and a concluding sentence.</p>
<p>Note from your teacher: bring a highlighted copy of the passage on the day of the writing assessment.</p></div>`);

(async () => {
  const b = await chromium.launch(); const pg = await b.newPage();
  const pdf = async (html, out) => { await pg.setContent(html); writeFileSync(join(root, out), await pg.pdf({ format: 'Letter', margin: { top: '0.8in', bottom: '0.8in', left: '0.9in', right: '0.9in' } })); };
  await pdf(algebra, 'samples/absolute-value-review.pdf');
  await pdf(history, 'samples/dust-bowl-packet.pdf');
  await pdf(english, 'samples/lantern-path-passage-and-rubric.pdf');
  // A scanned-style PDF and a screenshot: pages that are only pictures, with no text layer.
  await pg.setViewportSize({ width: 800, height: 520 });
  await pg.setContent(doc(`<div style="padding:30px"><h1>Quick notes (photo of a notebook)</h1><p>Photosynthesis: plants turn light, water and carbon dioxide into glucose and oxygen.</p><p>Chlorophyll absorbs light energy in the chloroplast.</p></div>`));
  const png = await pg.screenshot(); writeFileSync(join(root, 'samples/notebook-screenshot.png'), png);
  await pg.setContent(`<html><body style="margin:0"><img src="data:image/png;base64,${png.toString('base64')}" style="width:100%"></body></html>`);
  writeFileSync(join(root, 'tests/fixtures/scanned.pdf'), await pg.pdf({ format: 'Letter' }));
  await b.close();
  writeFileSync(join(root, 'tests/fixtures/corrupt.pdf'), '%PDF-1.4\nthis is not really a pdf, it was cut off');
})();

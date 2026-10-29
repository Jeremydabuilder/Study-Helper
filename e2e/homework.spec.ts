import { expect, Page, test } from '@playwright/test';
import { control, joinAs, signInAgain, watch } from './support';

const SHEET = `Algebra worksheet 4
1. Solve for x: 2x + 3 = 11
2. Solve: -2x < 6 [unreadable: smudged]
Due: Nov 5`;

async function addHomework(page: Page, text = SHEET) {
  await page.goto('/#/homework/new');
  await page.getByLabel('New subject name').fill('Algebra 1');
  await page.getByLabel('Instructions and questions').fill(text);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Check what I found' })).toBeVisible();
}

test('upload/paste → confirm what was found → work with help → check → save → resume after sign-out → finish; unreadable text blocks help until looked at', async ({ page }) => {
  const problems = watch(page);
  await joinAs(page, 'hw@example.test');
  await addHomework(page);
  // what was found is shown for confirmation: both questions, the stated date offered but not applied, and the unreadable part marked
  await expect(page.getByLabel('Text of question 1')).toHaveValue(/2x \+ 3 = 11/);
  await expect(page.getByText(/Part could not be read/)).toBeVisible();
  await expect(page.getByText(/The sheet says “Due: Nov 5”/)).toBeVisible();
  await expect(page.getByLabel(/Due date/)).toHaveValue('');
  await page.getByRole('button', { name: /Use 2026-11-05/ }).click();
  await expect(page.getByLabel(/Due date/)).toHaveValue('2026-11-05');
  await page.getByLabel('Text of question 2').fill('Solve: -2x < 6');
  await page.getByRole('button', { name: 'Looks right: start this homework' }).click();
  await expect(page.getByRole('heading', { name: 'Algebra worksheet 4' })).toBeVisible();
  await expect(page.getByText(/0 of 2 questions checked/)).toBeVisible();
  expect((await (await page.request.get('/api/items')).json())).toHaveLength(1); // one Plan entry, created on confirmation

  // question 1: a wrong step is found exactly, and help starts small
  await page.getByLabel('Your working for question 1').fill('2x + 3 = 11\n2x = 14\nx = 7');
  await expect(page.getByText(/Saved \(version 1\)/)).toBeVisible();
  await page.getByRole('button', { name: 'Check my work' }).click();
  const result = page.getByRole('region', { name: 'Check result' });
  await expect(result.getByText('Needs revision').first()).toBeVisible();
  await expect(result.getByText(/line 2 is the first line that does not follow/)).toBeVisible();
  await expect(result.getByText('does not follow', { exact: true })).toBeVisible();
  await expect(result.getByText(/This is not your teacher’s grade/)).toBeVisible();
  await page.getByRole('button', { name: 'Give me a hint' }).click();
  const log = page.getByRole('region', { name: 'Help so far' });
  await expect(log.getByText('Hint (level 1)')).toBeVisible(); await expect(log.getByText(/AI-written: can be wrong/)).toBeVisible();
  // fixing the working makes the old result "old", then a new check says correct for the exact lines
  await page.getByLabel('Your working for question 1').fill('2x + 3 = 11\n2x = 8\nx = 4');
  await expect(page.getByText(/Saved \(version 2\)/)).toBeVisible();
  await page.getByRole('button', { name: 'Check my work' }).click();
  await expect(result.getByText('Looks correct').first()).toBeVisible();
  await expect(result.getByText(/Exact check: 3 lines follow/)).toBeVisible();
  await page.getByRole('group', { name: 'Status of question 1' }).getByRole('button', { name: 'Completed' }).click();
  await expect(page.getByText(/1 of 2 questions checked/)).toBeVisible();
  await expect(page.getByText(/not a prediction of your grade|This is not a prediction/).first()).toBeVisible();

  // a worked solution needs a deliberate yes and is remembered as shown, not as understanding
  await page.getByText('Question 2').first().click();
  await page.getByRole('button', { name: 'Show the worked solution' }).click();
  await expect(page.getByText(/will not.* count as showing you can do it yourself/)).toBeVisible();
  await page.getByRole('button', { name: 'Yes, show it' }).click();
  await expect(page.getByRole('region', { name: 'Help so far' }).getByText('Worked solution')).toBeVisible();
  await expect(page.getByText('Worked answer shown').first()).toBeVisible();
  const prog = await (await page.request.get('/api/progress')).json();
  expect(prog.practiceAccuracy.n).toBe(0); // nothing here counts as practice evidence

  // sign out and back in: everything is where it was
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signInAgain(page, 'hw@example.test');
  await page.goto('/#/homework');
  await page.getByRole('link', { name: 'Algebra worksheet 4' }).click();
  await expect(page.getByText(/1 of 2 questions checked/)).toBeVisible();
  await page.getByText('Question 1').first().click();
  await expect(page.getByLabel('Your working for question 1')).toHaveValue('2x + 3 = 11\n2x = 8\nx = 4');
  await page.getByRole('button', { name: 'I’m done with this homework' }).click();
  await expect(page.getByText('Some questions are not completed')).toBeVisible();
  await page.getByRole('button', { name: 'Mark done anyway' }).click();
  await expect(page.getByRole('button', { name: 'Reopen' })).toBeVisible();
  expect(problems, problems.join('\n')).toEqual([]);
});

test('unreadable text must be fixed or acknowledged before the app solves anything, and a double click records one hint', async ({ page }) => {
  const problems = watch(page);
  await joinAs(page, 'hw2@example.test');
  await addHomework(page, 'Science lab\n1. Explain what this graph shows [diagram: a line graph of plant height over weeks]\n2. Why do plants need light?');
  await page.getByRole('button', { name: 'Looks right: start this homework' }).click();
  await expect(page.getByText(/Part of this question could not be read/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Give me a hint' })).toBeVisible();
  await page.getByRole('button', { name: /I have looked at the original and the text is complete/ }).click();
  await expect(page.getByText('You said you looked at it.')).toBeVisible();
  await control('llm-delay', { ms: 300 });
  await page.getByRole('button', { name: 'Give me a hint' }).dblclick();
  await expect(page.getByRole('region', { name: 'Help so far' }).getByText(/Hint \(level 1\)/)).toHaveCount(1);
  const qid = (await (await page.request.get('/api/homework')).json()).homework[0].id;
  const detail = await (await page.request.get(`/api/homework/${qid}`)).json();
  const hist = await (await page.request.get(`/api/homework/questions/${detail.questions[0].id}/help`)).json();
  expect(hist.help).toHaveLength(1);
  await control('llm-delay', { ms: 0 });
  expect(problems, problems.join('\n')).toEqual([]);
});

test('test mode: only concept help, and the question is not shown to the assistant', async ({ page }) => {
  await joinAs(page, 'hw3@example.test');
  await addHomework(page, 'Quiz review\n1. Solve for x: x + 4 = 9\n2. Solve for x: x - 1 = 3');
  await page.getByRole('button', { name: 'Looks right: start this homework' }).click();
  await page.getByText('I’m done').first().isVisible();
  await page.getByLabel('This is a test or quiz in progress').click();
  await expect(page.getByText(/Test mode is on/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Give me a hint' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Check my work' })).toBeDisabled();
  await page.getByLabel('Which concept do you want explained?').fill('how to undo addition');
  await page.getByRole('button', { name: 'Explain the idea' }).click();
  await expect(page.getByRole('region', { name: 'Help so far' }).getByText('Explain the idea')).toBeVisible();
});

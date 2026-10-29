# Homework helper

One workspace per assignment, inside the existing app (no separate chatbot). Everything is stored in the student's own database and is covered by the same ownership checks, quotas and export/delete as the rest of the account.

## What a student can do
1. **Add** an assignment: paste the instructions, or upload a PDF/photo (read and reviewed with the existing upload review page, original shown beside the text).
2. **Check what was found.** Questions are split only where the sheet has visible numbering/lettering (`1.`, `Q2`, `(a)`). No numbering → one flagged question that must be acknowledged. A date is offered only if the sheet states one (quoted back; "due Friday" gives no date). Unreadable parts (`[unreadable…]`, `[diagram…]`) are marked; help and checking stay off for that question until the text is fixed or the student says they looked at the original.
3. **Confirm** subject, kind, due date, estimate (a suggestion, editable). If the assignment is probably already in the Plan or Calendar proposals, the student must choose "attach to this" or "separate entry"; the same Plan entry can never belong to two homeworks.
4. **Work** on each question: typed working is saved as versions (autosave, draft kept in the browser if the network drops, stale tabs cannot overwrite). Working can also come from a photo that went through the review page.
5. **Get help**, smallest first: explain the question, help me start, hint (levels 1→3, one step per request), explain the idea, worked solution (needs an explicit yes), help with wording (English).
6. **Check my work**: line-by-line exact check for typed math; the assistant's opinion (labelled) for other subjects; always with "not checked" listed.
7. **Dispute** a check (answer is right / key is wrong / misread). The original check and answer are kept; the dispute is added.
8. **Status** per question (not started / working / stuck / completed) is the student's own statement. It is separate from correctness and from understanding.
9. **Test mode**: if the student declares a test/quiz in progress, only general concept help is available and the question text and answers are never sent to the assistant.

## Rules the code enforces (each has a test)
- Nothing invented: questions, dates, unreadable text, quotations. Quotation marks in a model reply that are not in the provided text are removed. Model comments about words the student did not write are dropped. Evidence quotes not in the provided material are dropped and the basis is downgraded to "general".
- Math is exact where the app can be exact (`src/core/stepcheck.ts`): each line is compared with the line before by solution set / value, so a different valid method is never marked wrong and the first line that does not follow is named (sign slip, flipped inequality, endpoint, lost/extra solution, arithmetic, copy mismatch, domain note, units note). Lines it cannot read are "not checked", never wrong. The model is told to trust these findings. A model-written worked solution is shown only if it reaches the answer the app computed.
- A check is never turned into "the assignment is correct": the assignment view reports how many questions were checked on their *current* working, how many were found correct / need revision / could not be fully checked, and says it is not a grade prediction.
- English/history: quotations are compared word for word with the provided source; rubric feedback never claims a teacher's score; suggested edits are separate and the student's text is never rewritten.
- Assistance ledger per question: independent so far → hint → explanation viewed → AI helped with wording → worked answer shown. Completed/assisted homework **never** writes `attempts` or `concept_state`; it cannot create or raise independent evidence.
- Memory: only (a) exact findings of a specific slip (observed) and (b) things the student said ("I'm stuck on…", student-stated) and (c) "saw the worked answer" are saved, with provenance (homework, question, check, assistance). They never describe the student, can be dismissed on the Memory page, and a dismissed note is not recreated.
- Later check: optional. It adds an ordinary Study follow-up on a linked topic for tomorrow or later; homework questions are excluded from practice-question generation for that topic, so the answer just seen is not repeated.
- Instruction-like passages in a sheet are shown to the student but replaced by a marker in what the model sees.
- Plan: confirmed homework is a normal Plan item (estimate, due date). "Homework next" (Today and Homework pages) picks the pinned homework, else the one due soonest, and inside it the question in progress; conflicts come from the same schedule as the Plan page and the student decides what goes first. Active time (page visible and recent input) is logged in 10-minute-capped chunks; a learned estimate needs at least three finished assignments of the same kind and is only a suggestion.

## Costs and limits
Exact math checks and offline fallbacks cost nothing. Assistant calls go through the existing provider layer, budgets, per-student and global limits (hosted). At most 40 questions per sheet, 150 homeworks, 20,000 characters of working per question, 200 versions per question.

## Testing status
Automated, mocked model: `tests/stepcheck.test.ts`, `tests/homeworkParse.test.ts`, `tests/homework.test.ts` (math, history, science, English, multi-question sheet, partly unreadable text, alternative method, wrong intermediate step, contradiction-free source handling, duplicate/interrupted requests, failure keeps work, assessment mode, assisted completion adds no evidence, fresh check), `tests/hostedHomework.test.ts` (cross-account attempts on every route, sign-out/in, export, delete) and `e2e/homework.spec.ts` + a phone test.
**Not verified:** real model quality for hints/checks/rubric feedback (no live key or spending authorisation), real handwriting/photo transcription of working, and the exact-check coverage on real student notation beyond the cases in the tests.

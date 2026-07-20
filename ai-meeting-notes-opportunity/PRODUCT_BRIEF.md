# Signal Notes — product opportunity brief

## Recommendation: GO, narrowly

Proceed only with a validation-first wedge: a meeting follow-through workspace that turns imported or pasted conversation into **reviewable decisions and owned commitments**. The evidence log shows that Otter and Fireflies already market transcription, summaries, action items, search, and downstream integrations. It also shows a concrete customer pain: generated transcripts may need correction before sharing. The recommended product is therefore a controlled post-meeting layer, not another generic recording bot.

This decision is based only on the five sources in [research/evidence.md](research/evidence.md). Pricing, positioning details, and experiment targets below are hypotheses to test, not evidence-backed facts.

## Target user and painful job-to-be-done

**Target user:** a project lead, client-services lead, or small-team founder who runs recurring cross-functional or client meetings and is accountable for making the follow-up unambiguous.

**Job-to-be-done:** “After a meeting, help me turn a messy conversation into a trustworthy, shareable set of decisions and commitments—each with an owner, due date, and source context—without manually reconstructing the notes.”

**Pain:** raw transcript and summary output can be hard to trust, hard to correct, and disconnected from the work that must happen next. The G2 reviewer explicitly reports correcting transcripts before sharing; the competitor pages establish that simple notes and action extraction are already expected.

## Competitor comparison

| Product | Evidence-backed baseline | Consequence for Signal Notes |
| --- | --- | --- |
| Otter | Generates summaries, action items, searchable insights, and connects notes to tools such as Salesforce, Jira, and Slack. | Do not compete on “AI notes” or a generic integration checklist. Compete on making each decision and commitment reviewable before it is released. |
| Fireflies | Markets detailed notes, action items, customized summaries, transcription, and automatic task creation. | Do not compete on automatic extraction alone. Treat the human review step as the product’s center of gravity. |
| Signal Notes | Proposed: decision ledger, owner/date confirmation, source-linked highlights, and an exportable handoff. | Wedge is a calm, accountable follow-through workflow for teams that need a final, checked artifact. |

## Differentiated wedge

**“From meeting noise to a signed-off commitment ledger.”**

The product starts after the transcript exists. It highlights candidate decisions and action items, asks the meeting owner to confirm the owner/date/wording, preserves source context, and exports a concise outcome record. This makes the unavoidable correction step visible, fast, and safe.

Positioning boundary: this is for small teams that need meeting outcomes to move work forward. It is not an enterprise call-recording or conversation-intelligence suite.

## MVP scope

- Import a local transcript or paste text; show a clear processing/import state.
- Create a meeting workspace with transcript highlights, decisions, and action items.
- Let the user search/filter all three views.
- Let the user change an item’s owner, due date, wording, and confirmation state.
- Link each decision/action item to a transcript moment.
- Export an outcome summary as Markdown/CSV-style text.
- Use local mock data for this prototype; a real MVP can begin with manual paste/import before calendar bots.

### Explicit non-goals

- No meeting bot, calendar auto-join, recording, or live transcription.
- No claim of superior speech-to-text accuracy.
- No CRM/project-management synchronization in v1.
- No enterprise admin, compliance, or multi-workspace permissions.
- No autonomous task creation without an explicit user review.

## Pricing hypothesis

Test a **$12–18 per active organizer per month** self-serve plan with a limited free tier (for example, a small number of reviewed meeting exports). The value metric should be outcomes reviewed/exported, not minutes recorded. This is a hypothesis, chosen to keep the buyer and job focused; it is not derived from competitor pricing research.

## Biggest risks and cheapest validation experiment

| Risk | Why it matters | Cheapest test |
| --- | --- | --- |
| The wedge is too close to existing note-takers. | Otter and Fireflies already claim action items and integrations. | Show the clickable prototype plus a one-page “reviewed commitment ledger” sample to 10 target users. Ask them to bring one recent meeting transcript and complete the review flow. Success: at least 4 independently ask to use it again or agree to a paid pilot conversation. |
| Users will not spend time reviewing. | Review is the differentiator, but it adds a step. | Time a concierge workflow: prepare candidate decisions/actions from a supplied transcript, then measure whether a user can approve or correct them in under 5 minutes. |
| Import quality and context are insufficient. | The review must be more trustworthy than a detached summary. | Test source-linked highlights and require users to resolve ambiguous speaker/owner fields. Record the reasons for correction before building automation. |
| Privacy and consent block access to meeting data. | Meeting content is sensitive. | Start with user-uploaded, already-shared transcripts; ask specifically about consent and retention requirements before collecting any recordings or adding a bot. |

## Decision rule after validation

Continue only if target users repeatedly choose the reviewable export over their existing notes process and can name a recurring meeting where they would use it. If they merely praise transcription or ask for a calendar bot, stop: that would pull the product into an already crowded baseline.

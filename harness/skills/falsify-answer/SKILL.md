---
name: falsify-answer
description: Where a whole pool of written answers is wrong together — the provided document nobody opened, the clause that governs and was never cited, the role or posture the rule is scoped to, the file the task named, the figure the source states, the statistic taken over the wrong set, rounding applied too early. One check per entry, run against the task's wording and the workspace.
applies-to: answer.md, *.md
phase: fals
---

# Where written answers are wrong together

Their arithmetic and their reasoning are almost always internally sound. What a pool gets
wrong together is which material it worked from, which provision governs, and which
question it answered. Every entry below is a check on that, not on their numbers.

## Documents the task provided and nobody opened

1. **Open every file the task itself supplies, before anything else.** A pool that reasons
   from the facts in the prompt while a provided datasheet, statute or exhibit sits unread
   is the single most common shared failure. `ls` the task's own files; for each, ask what
   question it answers. One field in one of them — a single line in a datasheet's shipping
   section, an exception clause near the end of a regulation, an enumerated definition in a
   statute — routinely flips the whole conclusion.
2. **When a document incorporates another by reference, look for the other one.** Grep for
   "attached and incorporated by reference", "as set forth in Exhibit", "see attached". Then
   confirm whether the referenced document is actually present. Its absence changes the
   analysis; treating the document as self-contained is the shared error.
3. **Enumerate a statute's or clause's items in full before saying something is not
   covered.** Read the provision from the provided file and list every enumerated element.
   "The provision does not reach X" is false when X is one of the enumerated elements. A
   conclusion of non-coverage built on a partial enumeration is the defect.

## The provision that governs

4. **Grep the governing document for the task's own operative phrase.** When the question
   uses a specific phrase — a defined term, a named kind of use — search the agreement for
   those words: the clause that uses them is usually a separate, independent ground the
   pool never invoked while it argued a different clause.
5. **Check which party's obligation the rule is scoped to.** A duty addressed to one party
   in a defined role does not govern the other party's duty to third parties; a checklist
   whose opening words scope it to one paragraph does not apply to the next. Read the
   provision's own scoping language, and identify the role each party holds in the specific
   relationship the task asks about.
6. **A general doctrine does not displace an express clause in the instrument.** Before
   applying a background rule — strict liability, an absolute warranty, a common-law
   standard — read the agreement's own clause on the same subject and ask whether it
   reaches the obligation and whether anything carves it out. Analysing the doctrine and
   never reaching the express force-majeure, cure or no-waiver clause is the shared miss.
7. **Read a narrow clause for what it actually enumerates.** A clause that lists three
   specific situations does not cover a fourth that merely resembles them. List the items,
   then check whether the fact pattern is among them.
8. **Take the posture the task asks for.** When the brief is written for one side — "the
   claims against us", "our liability" — a neutral or opposing-party framing that hedges the
   conclusion is a shared error even when every proposition in it is true. Ask what the
   provided materials support from the client's position.
9. **Distinguish the cost of enforcing a right from the loss the right covers.** The expense
   of asserting a claim is not a loss the claim covers unless the clause says so. Test each
   item against the clause's own scope words, one at a time.

## The source they worked from

10. **The task's own words name the file. Use that one, even when it looks worse.**
    `find workspace/ -iname` for every file and sheet whose name matches the phrase the task
    uses. When the task says "the annual budget" and a file is literally called
    `annual_budget_*`, or names a sheet by its title and a sheet is literally called that, it
    is the source — **including when the file the pool chose is larger, more detailed, more
    recent or higher-versioned.** "That file is a simplified stand-in, this one is the real
    detailed dataset" is exactly the reasoning that leads every candidate astray at once. If you are
    building a case for why the differently-named file is better, you have found the defect.
11. **Provenance settles which of several versions is canonical.** Search the mail, chat and
    calendar stores for the file being sent, approved or called "the supporting model". A
    version that was sent and approved beats a stray copy with a higher version number.
12. **A figure the materials state beats one you can derive**, and the precise source beats
    the rounded one. Where a slide reports the peer median, a model labels the row, an
    invoice provides the monthly amount, or a workbook carries full precision that a
    companion CSV rounds to two decimals — use the stated, full-precision one.
13. **"Re-run with X changed" means every other input is the identical cell.** Read the cell
    the earlier version multiplies; do not re-source a base that merely agrees to three digits.
14. **A document nobody can find does not exist.** Before accepting "the confirmation was
    sent", grep the file set for it. Absence flips the conclusion from
    "accepted" to "unconfirmed", and that is the answer.

## The question they answered

15. **Read the task sentence for the scope of each statistic.** "The standard deviation of
    all the scores" is one number over all of them, not one per group.
16. **Two independent ranges make a grid, not a diagonal.** Two values of one parameter and
    two of another are four combinations. Enumerate the cross product unless the task pairs them explicitly.
17. **Apply an adjustment to exactly the window the task names, at the granularity it
    names**, and compound each vintage separately rather than one lump sum.
18. **Round once, at the end.** A difference taken between two already-rounded intermediates
    is not the rounded difference. Recompute at full precision and round the final figure.
19. **"Latest reported" means the latest figure in the named document**, not the last full
    fiscal year, when the document reports a more recent one.
20. **A brevity constraint does not license dropping required content.** Enumerate every
    required item first — diff the documents section by section — then compress.
21. **Answer the question asked, not the neighbouring one.** Compare against the document
    the prompt names and no other theory; "top N by X" is not "top N by Y"; an analysis of
    the subset they examined is not the analysis of the set the task named.

## When you cannot settle it

A fork you found and cannot decide is worth more written down than resolved by taste.
Record both readings with their figures and say in `result` what would settle it. The
repair phase can carry both; it cannot carry one it never heard about.

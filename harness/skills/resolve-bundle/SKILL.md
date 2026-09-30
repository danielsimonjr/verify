---
name: resolve-bundle
description: How to settle a split between bundles of office files - what counts as deciding evidence when candidates differ in file names and formats, in how they counted or aggregated the source data, or in what they included. The task's stated contract and the source data's own categories decide; polish and volume do not.
applies-to: *.docx, *.pptx, *.csv, *.html, *.txt, *.doc, *.xlsx, *.xlsm
phase: elim
---

# Settling a split between file bundles

## The contract

1. **The task's stated output is the contract, byte for byte.** Where the prompt names the
   required files, a candidate whose file carries that exact name, type and location meets
   it and one with a descriptive, sensible, different name does not. The same goes for a
   stated length, language or "preserve the original formatting".
2. **Scope is part of the contract.** When the task enumerates what to extract or report,
   the candidate that delivers those items is not outranked by one that delivers more.

## The basis of a count

3. **A distinct status value in the data is a distinct figure in the report.** Where
   candidates differ because one folded a partial status into its full one, recompute each count
   on the literal value and see which the brief lists separately.
4. **An exclusion applies only where its own record reaches.** Match each exclusion to the
   dates and the reason its record names; a blanket window is the usual source of the
   difference.
5. **Read the scope word in the task sentence.** "The" statistic over "all" records is one
   number; a per-group table is not it, and a threshold computed per segment is not the
   threshold over the whole set.
6. **Two independent parameter ranges make a grid, not a diagonal**, unless the task pairs
   them explicitly.

## What the task or an input enumerates

7. **A list in the task or in an input is a checklist, item by item.** Constraints in a
   handbook or roster, strata a proposal names, sections a style guide must establish,
   sources a comparison must draw on, metrics or rubric categories a brief lists, the
   rows of a table to be compared: record for every candidate which items it covers
   before ranking anything. A candidate's extra insight does not outrank a breach of a
   listed constraint, and "covers the topic" is not coverage of the item.
8. **A closed vocabulary is checked row by row.** When the task or a template fixes the
   allowed values of a field ("one of: X, Y, Z"; an enum sheet), every row holds exactly
   one listed value; where one value names the case exactly, the catch-all is a defect.
   Identifiers, labels and source tokens from the inputs stay verbatim in the
   deliverable; a paraphrase is a departure, not a style choice.
9. **"All equal" and "no adjustment needed" are recomputed over the whole table.** A
   claim that a normalisation is zero, that every entity meets a threshold, or that a
   reason column agrees with the deliverable is checked on every row and every entity
   in the input, not on the rows the task happened to name.
10. **A workbook in a bundle is read on its stored values.** A reader of the bundle — and a
    rubric judge — opens cached values: a formula without one is an empty cell to them,
    whatever it would compute. Formula-driven versus literal is neither merit nor defect
    unless the task asks for a live model; a candidate whose figures are present as values
    is not outranked by one whose figures exist only as uncomputed formulas. The inventory
    tool's shape section and the `.cells.tsv` header give the count per workbook.

## Presence

7. **A specific only some candidates state is a difference worth recording, not a defect of
   the others' and not a fabrication by default.** Check it against the source (`grep` the
   figure, the identifier, the clause). Confirmed, it is material a later phase can use
   whichever candidate is chosen; record who has it and where. The inventory tool
   (evidence-bundle) lists such specifics across all candidates at once.

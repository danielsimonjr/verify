---
name: resolve-patch
description: How to settle a split between code patches - what counts as deciding evidence when candidates fix different places, read an underspecified requirement differently, or add behaviour the task did not ask for. The task's own words, the repository's existing idiom and executed behaviour decide; diff size and a majority do not.
applies-to: *.patch, *.diff
phase: elim
---

# Settling a split between patches

Patches for one task usually agree on the shape of the fix and split on a few
choices. Settle each from evidence you can point to, in this order:

1. **Executed behaviour at the entry point the task names.** Build every candidate
   (evidence-patch) and run the call, command or input the task describes. The
   candidate whose behaviour matches the task's sentence wins over one that fixes a
   helper the sentence never mentions, whatever the diff sizes.
2. **The task's own words for the universe and the format.** "Per user", "every
   record", "all files" mean the entities present in the inputs, not a set derived
   from labels or results; a field the task names in the singular holds one value.
   A reading that narrows or widens the universe on the strength of what "makes
   sense" is an argument, not evidence.
3. **The repository's existing idiom.** Where the task leaves an option's spelling,
   a default or an error type open, the way the code base already does it decides;
   a candidate inventing a new keyword or convention is charged for the departure.
4. **The project's tests as they stand.** A candidate that breaks a passing test is
   charged; tests a candidate wrote for itself prove nothing about the others.
5. **What most candidates did.** Last, and only when nothing above speaks.

Behaviour the task did not ask for - an extra option, a wider tolerance, an error
turned into a silent skip - is not a merit, and a smaller diff is not a merit either:
neither says anything about whether the reported behaviour is fixed. When two
readings remain defensible after 1-4, record both with what each yields; do not
close the fork by taste.

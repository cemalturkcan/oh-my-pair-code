---
name: source-faithful-document-pdf
description: Rebuild structured documents into PDFs from spreadsheets, scans, or reference images without dropping fields, drifting labels, or prioritizing layout ahead of source fidelity.
---

## Purpose

Use this skill when a user wants a spreadsheet, scan, or mixed-source business document turned into a clean PDF that still preserves the source document's actual content.

This skill exists to prevent the exact failure mode where the output starts looking better while becoming less faithful to the source.

## Use When

- The source is `.xls`, `.xlsx`, `.csv`, `.docx`, `.pdf`, HTML export, OCR text, or a screenshot of a structured document.
- The user provides a reference image and wants “something like this” or “convert this into a PDF like the sample”.
- The document has named fields, legal or payroll terminology, totals, signatures, or compliance-sensitive wording.
- Missing or renamed line items would make the result misleading.

## Core Rule

Content correctness beats visual cleanup.

Do not start polishing layout until you know exactly which fields and labels must survive into the final document.

## Working Method

1. Extract the source content first.
2. Build a field inventory before designing anything.
3. Compare the source inventory against the requested output and reference image.
4. Lock the required labels and values.
5. Only then rebuild the layout.
6. Validate the final PDF against the inventory before delivering it.

## Field Inventory Discipline

Before generating the final PDF, explicitly list:

- section titles
- field labels
- field values
- calculated totals
- optional blocks that may or may not belong in the final output

Treat similar-looking labels as different fields unless the source proves they are the same.

Examples of dangerous drift:

- `Invoice total` vs `Amount due`
- `Statement balance` vs `Current charge`
- source-required totals vs visually convenient replacements

## Source Precedence

When multiple sources disagree, use this order unless the user says otherwise:

1. authoritative structured source data from the original editable file
2. explicit user corrections or required wording
3. original exported document text
4. OCR output
5. reference image layout cues

If two high-authority sources conflict on labels, values, or required blocks, stop and ask instead of guessing.

## Reference Image Rules

- Use the reference image for layout, spacing, and visual hierarchy.
- Use the source file for truth.
- If the reference omits fields but the source includes them, do not silently drop them.
- If the source includes optional blocks like date/signature, include them only when the user wants them or when the target document clearly requires them.

## Layout Rules

- Prefer fixed-position layout only after the field inventory is complete.
- Keep typography and spacing clean, but never at the cost of removing required lines.
- If the user wants a clean digital PDF, do not imitate scan artifacts unless asked.
- Keep output to one page only if the content still remains complete and readable.

## Validation Checklist

Before finishing, verify all of these:

1. Every required field from the inventory appears in the PDF.
2. Labels match the intended wording exactly.
3. Values were not reformatted into a misleading alternative meaning.
4. Added blocks were explicitly requested or clearly required.
5. Removed blocks were explicitly excluded or clearly unnecessary.
6. Page size and alignment match the user's request.

## Failure Patterns To Avoid

- Converting first and trusting the default export as the final answer.
- Rebuilding visually from memory instead of from an extracted field list.
- Omitting lower-page totals because the page already “looks complete”.
- Replacing a missing tax line with a nearby payroll line.
- Keeping signature/date blocks just because they existed in the raw source when the user asked for them removed.

## Guardrails

- Do not invent values that are not present in the source.
- Do not rename labels to sound nicer or more standard unless the user explicitly asks.
- Do not trade legal or payroll precision for aesthetics.
- If a field is ambiguous, stop and ask instead of guessing.

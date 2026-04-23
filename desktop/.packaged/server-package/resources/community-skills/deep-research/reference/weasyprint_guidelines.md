# WeasyPrint PDF Generation Guidelines

## Overview

WeasyPrint converts HTML/CSS to PDF. These guidelines ensure professional output without awkward page breaks, orphaned content, or layout issues.

---

## Critical CSS Properties for Page Breaks

### Prevent Breaking Inside Elements

```css
/* Apply to containers that should never split across pages */
.executive-summary,
.key-insight,
.warning-box,
.action-box,
.diagram,
.metrics-row,
table {
    page-break-inside: avoid;
}

/* Tables are especially problematic - always prevent breaks */
table {
    page-break-inside: avoid;
}

/* Two-column layouts */
.two-col {
    page-break-inside: avoid;
}
```

### Prevent Orphaned Headers

```css
/* Headers should never appear at bottom of page without content */
h2, h3, h4 {
    page-break-after: avoid;
}
```

### Prevent Widows and Orphans in Text

```css
p {
    orphans: 3;  /* Minimum lines at bottom of page */
    widows: 3;   /* Minimum lines at top of page */
}
```

---

## @page Rules

### Basic Setup

```css
@page {
    size: A4;
    margin: 25mm 20mm 25mm 20mm;

    @top-center {
        content: "Report Title";
        font-family: Georgia, serif;
        font-size: 9pt;
        color: #666666;
    }

    @bottom-center {
        content: counter(page);
        font-family: Georgia, serif;
        font-size: 10pt;
    }
}

/* Suppress header on first page */
@page :first {
    @top-center { content: none; }
}
```

---

## Table Design for PDF

### Avoid Large Tables

- Keep tables under 8-10 rows when possible
- Split large data sets into multiple smaller tables
- Use `page-break-inside: avoid` on every table

### Table CSS

```css
table {
    width: 100%;
    border-collapse: collapse;
    margin: 12pt 0;
    font-size: 9pt;
    page-break-inside: avoid;
}

th {
    background: #1a1a1a;
    color: white;
    padding: 8pt 10pt;
    text-align: left;
    font-size: 8pt;
    text-transform: uppercase;
}

td {
    padding: 8pt 10pt;
    border-bottom: 0.5pt solid #d0d0d0;
    vertical-align: top;
}
```

---

## Typography for Print

### Font Sizes (pt not px)

Use points for print, not pixels:

```css
body {
    font-family: Georgia, "Times New Roman", Times, serif;
    font-size: 10pt;
    line-height: 1.6;
}

h1 { font-size: 22pt; }
h2 { font-size: 14pt; }
h3 { font-size: 11pt; }

/* Small text */
.citation { font-size: 8pt; }
.footer { font-size: 8pt; }
.bib-entry { font-size: 8pt; }
```

### Line Height

- Body text: 1.6-1.7
- Tables: 1.4-1.5
- Bibliography: 1.5

---

## Layout Patterns That Work

### Use `display: table` for Side-by-Side

Flexbox and Grid have limited WeasyPrint support. Use `display: table`:

```css
.two-col {
    display: table;
    width: 100%;
    page-break-inside: avoid;
}

.col {
    display: table-cell;
    width: 50%;
    padding: 10pt;
    vertical-align: top;
}

.col:first-child {
    border-right: 0.5pt solid #cccccc;
}
```

### Metrics Dashboard

```css
.metrics-row {
    display: table;
    width: 100%;
    border: 1.5pt solid #000000;
    page-break-inside: avoid;
}

.metric {
    display: table-cell;
    width: 25%;
    padding: 12pt 8pt;
    text-align: center;
}
```

---

## Content Boxes

### Insight/Warning Boxes

```css
.key-insight {
    background: #f5f5f5;
    border-left: 3pt solid #000000;
    padding: 10pt 12pt;
    margin: 12pt 0;
    page-break-inside: avoid;
}

.warning-box {
    background: #1a1a1a;
    color: white;
    padding: 12pt 15pt;
    margin: 12pt 0;
    page-break-inside: avoid;
}
```

### Diagrams

```css
.diagram {
    background: #f5f5f5;
    border: 1pt solid #000000;
    padding: 12pt;
    margin: 12pt 0;
    text-align: center;
    page-break-inside: avoid;
}
```

---

## Bibliography

```css
.bibliography {
    background: #f5f5f5;
    padding: 15pt;
    margin-top: 20pt;
    border-top: 2pt solid #000000;
}

.bib-entry {
    margin-bottom: 8pt;
    padding-left: 25pt;
    text-indent: -25pt;
    font-size: 8pt;
    line-height: 1.5;
    page-break-inside: avoid;
}
```

---

## Common Problems and Solutions

### Problem: Table Splits Across Pages

**Solution:** Add `page-break-inside: avoid` to table. If table is too large, split into multiple smaller tables.

### Problem: Header at Bottom of Page with No Content

**Solution:** Add `page-break-after: avoid` to all heading elements.

### Problem: Single Line at Top/Bottom of Page

**Solution:** Set `orphans: 3` and `widows: 3` on paragraphs.

### Problem: Flex/Grid Layout Breaks

**Solution:** Use `display: table` and `display: table-cell` instead.

### Problem: Images/Diagrams Cut Off

**Solution:** Add `page-break-inside: avoid` to container.

### Problem: Margins Too Tight

**Solution:** Use generous @page margins (25mm top/bottom, 20mm sides).

---

## Compact Report Strategy

To reduce page count while maintaining readability:

1. **Use 10pt base font** (not 12pt)
2. **Tighter line-height**: 1.5-1.6 instead of 1.8
3. **Smaller margins in boxes**: 10pt padding instead of 15pt
4. **Condensed bibliography**: 8pt font, tighter spacing
5. **Two-column layouts** for comparison data
6. **Inline metrics dashboard** rather than full-width cards

---

## Validation Checklist

Before generating PDF, verify:

- [ ] All tables have `page-break-inside: avoid`
- [ ] All boxed content has `page-break-inside: avoid`
- [ ] Headers have `page-break-after: avoid`
- [ ] Paragraphs have `orphans: 3; widows: 3`
- [ ] No Flexbox or Grid in critical layouts
- [ ] Font sizes in pt, not px
- [ ] @page margins defined
- [ ] Two-column layouts use `display: table`

---

## Generation Command

```bash
weasyprint input.html output.pdf
```

Options:
- `--presentational-hints` - Respect HTML presentational hints
- `-s stylesheet.css` - Apply external stylesheet
- `--pdf-variant pdf/ua-1` - Generate accessible PDF

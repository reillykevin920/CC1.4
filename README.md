# CC1.4
# Civic Compass  
Localized Civic and Municipal Code Reference Tool

## Overview

Civic Compass is a lightweight, offline-capable reference application designed for municipal inspectors, engineers, and staff who require fast, reliable access to governing codes and construction standards in the field.

The tool consolidates commonly referenced materials—such as the Boulder Revised Code (BRC), Design & Construction Standards (DCS), and related regulatory content—into a single, searchable interface optimized for real-world inspection workflows.

Civic Compass is intentionally **read-only** and **non-authoritative**. It is a reference aid, not a substitute for adopted code, ordinances, or official publications.

---

## Purpose

Municipal staff often need to:
- Locate specific code sections quickly (e.g., “8-5-12”)
- Review construction standards while in the field
- Cross-reference requirements across multiple documents
- Operate in areas with limited or no internet connectivity

Civic Compass addresses these needs by providing a fast, intuitive, and offline-ready reference environment aligned with typical construction and inspection processes.

---

## Key Features

### Search
- Relevance-based search that prioritizes exact section and chapter matches
- Supports structured queries such as “Section 8-5-12” or “Chapter 9”
- Results grouped by category for clarity
- Category groups dynamically reorder during search to surface the most relevant material first

### Category-Based Browsing
- Categories reflect common construction and inspection workflows
- Default (no-search) view follows a logical project lifecycle order
- During active search, categories with relevant results move to the top
- Categories with no matching results are hidden during search

### Read-Through Mode
- Full chapter or title read-through in a continuous scroll view
- Jump-to-section navigation within chapters
- Reduced visual noise to support focused reading of code text

### Offline-First Design
- Fully functional offline after an initial online load
- Designed for use on:
  - Desktop browsers
  - Android devices
  - iPhone and iPad via “Add to Home Screen”
- Suitable for field use where connectivity is unreliable or unavailable

### Lightweight Deployment
- Static files only (no backend or database)
- Can be hosted on GitHub Pages or any static hosting environment
- Minimal IT overhead for internal deployment

---

## Offline Usage Instructions

To enable full offline functionality:

1. Open the application once while online.
2. Perform at least one search and open a chapter or section to ensure data files are cached.
3. Allow the application to remain open briefly so caching can complete.
4. Add the application to the device home screen (mobile devices).
5. The application will function in airplane mode thereafter.

---

## Disclaimer and License

This application is provided as an **internal reference tool** only.

- It is **not an official or controlling source** of law, regulation, or standard.
- In the event of any discrepancy, the **adopted municipal code, ordinances, standards, and officially published documents govern**.
- Users are responsible for verifying requirements against authoritative source documents.

This tool does not provide legal advice and should not be relied upon as such.

---

## Status

Civic Compass is production-ready for internal municipal reference use.

Future enhancements may include additional jurisdictions, expanded corpora, or deployment-specific customization as needed.

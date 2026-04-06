# CFA La Rambla — Restaurant Admin Hub

## Overview

All-in-one restaurant operations platform for CFA La Rambla (Chick-fil-A franchise in Bayamon, Puerto Rico). Built to replace scattered Excel spreadsheets, Word docs, and manual processes with a unified web application covering HR, operations, finance, marketing, and leadership development.

**Stack:** Express.js + SQLite (better-sqlite3) + Vanilla HTML/JS/CSS
**Deployment:** DigitalOcean droplet, PM2 process manager, Nginx reverse proxy with SSL
**Users:** ~130 employees, 5-6 admin/director users
**Database:** 46 tables, 22 migration versions
**Codebase:** ~100+ API endpoints across 13 route modules

---

## Portals

### Admin Portal (`index.html`)
Full management dashboard accessible to users with `admin` system role. Contains all modules via tab navigation.

### Employee Portal (`employee.html`)
Self-service portal for all employees. Shows tabs conditionally based on role:
- **All employees:** Accrual balances, time-off history, request submission, punch adjustments, own performance reviews, own AC evaluations
- **Directors/Senior Directors/Shift Leaders:** Manage team reviews, submit AC evaluations, executive scorecard, social posts
- **Trainers:** Submit AC evaluations (read-only employee lists)
- **Administrator role:** Gastos invoice management
- **Leadership Academy candidates:** Checkpoint progress, evidence uploads, learning resources

### Login Portal (`login.html`)
PIN-based authentication with mandatory password change on first login.

---

## Modules

### 1. PTO & Accrual Management (Core Module)

The foundational module. Tracks vacation and sick day accruals for all employees based on hours worked.

**How it works:**
- Admin uploads monthly wage/hours Excel exports from the POS system
- System parses employee hours and calculates accruals using Puerto Rico labor law rules
- Employees earn sick and vacation days proportionally based on hours worked
- Balances are tracked with full audit history

**Key features:**
- Monthly accrual calculation engine with configurable earn rates
- Vacation and sick day balance tracking (earned vs. taken vs. remaining)
- Manual time-off entry for payroll adjustments
- Time-off request workflow (employee submits → admin approves/rejects)
- Punch adjustment requests with employee acknowledgment
- Accrual recalculation and historical auditing
- Employee flagging system for inactivity (consecutive months with zero hours)
- CSV/PDF export of accrual statements
- Email and Slack notifications for milestones (anniversaries, balance alerts)

**Database tables:** `employees`, `users`, `monthly_hours`, `accruals`, `time_off_taken`, `time_off_requests`, `notification_settings`, `milestone_notifications`

---

### 2. Attendance Analytics

Two sub-modules for tracking attendance compliance.

#### 2a. Tardiness Tracking

**How it works:**
- Admin uploads bi-weekly tardiness reports from the POS system (Excel)
- System parses scheduled vs. actual clock-in/out times
- Calculates variance in minutes and classifies each record (OK, Infraction, Flag, Absence)
- Infraction notifications sent to employees via email/Slack

**Key features:**
- Excel parsing with automatic variance calculation
- Classification engine (configurable thresholds)
- Infraction notification system (email + Slack DM)
- Historical report archive with drill-down
- Export capabilities

**Database tables:** `tardiness_reports`, `tardiness_records`

#### 2b. Meal Penalty Tracking

**How it works:**
- Admin uploads meal penalty reports (Excel)
- System identifies employees who worked consecutive hours exceeding legal break requirements
- Tracks violations for compliance and coaching

**Key features:**
- Consecutive work time calculation
- Violation pattern identification
- Historical reporting

**Database tables:** `meal_penalty_reports`, `meal_penalty_records`

---

### 3. Performance Reviews

Quarterly performance evaluation system with differentiated criteria for FOH (Front of House) and BOH (Back of House) employees.

**How it works:**
- Directors submit quarterly reviews for their team members
- Reviews score 6 competency areas on a 1-5 scale
- BOH employees have additional sub-section scores (primary, secondary, machines, breading, filleting, prep, breakfast)
- Team averages calculated across quarters for trend analysis

**Key features:**
- 6 competency areas: Operations, CFA Values, Communication, Guest Obsession, Responsibility, Culture
- BOH-specific sub-sections (7 station-level ratings)
- Overall score override option with comments
- Team average calculations by quarter
- PDF export of review summaries
- Director-only access for submission; employees see their own reviews

**Database tables:** `performance_reviews`

---

### 4. Attentive & Courteous (AC) Evaluations

Customer service evaluation system based on Chick-fil-A's Attentive & Courteous standards.

**How it works:**
- Evaluators (Directors, Shift Leaders, Trainers) observe employees during service
- They complete a checklist of Yes/No/N/A questions about service behaviors
- System calculates percentage scores and tracks trends over time

**Key features:**
- Two evaluation types: Order Taking and Meal Delivery
- Two locations: Front Counter and Drive-Thru
- Configurable question sets stored as JSON responses
- Score percentage calculation (yes_count / total_applicable)
- Filtering by evaluator, date range, employee, type, location
- Employee self-view of their evaluations

**Database tables:** `ac_evaluations`

---

### 5. Leadership Academy

Three-tier leadership development program tracking high-potential employees through structured competency checkpoints.

**How it works:**
- Admin enrolls a Team Member as a Leadership Academy candidate
- System auto-generates 56 checkpoint progress rows across 4 competency areas
- Candidates work through checkpoints at their own pace, uploading evidence
- Leaders review and approve checkpoints with ratings
- Candidates progress through Tier 1 (Foundations) → Tier 2 (Emerging Leaders) → Tier 3 (Senior Director)

**Key features:**
- 4 competency areas: People Leadership (20 checkpoints), Operations & Brand Standards (19), Financial Acumen (12), Hospitality (11)
- 56 total checkpoints across 3 tiers with descriptions and evidence requirements
- Checkpoint status tracking: Not Started → In Progress → Completed (with skill ratings 1-5)
- Evidence file upload system (images, PDFs)
- Leader approval workflow with notes
- 20 curated learning resources (books, TED talks, podcasts) with completion tracking
- Resource-to-checkpoint linking (which resources help with which checkpoints)
- Gap analysis showing strengths and areas for development
- Candidate dashboard with visual progress tracking
- Analytics: tier pipeline, competency completion rates, recent activity
- Excel export of progress reports
- Target LDP (Leadership Development Plan) dates

**Tiers:**
- Tier 1: Foundations (entry level leadership skills)
- Tier 2: Emerging Leaders (intermediate management)
- Tier 3: Senior Director (executive leadership)

**Database tables:** `la_competency_areas`, `la_checkpoints`, `la_candidates`, `la_checkpoint_progress`, `la_learning_resources`, `la_resource_progress`, `la_checkpoint_resources`

---

### 6. Executive Scorecard

Monthly KPI tracking dashboard for restaurant performance metrics.

**How it works:**
- Directors enter monthly metrics (sales, speed of service, food cost, labor, OSAT scores, etc.)
- OSAT (Overall Satisfaction) scores tracked by day of week for pattern analysis
- Historical data enables month-over-month trend tracking

**Key features:**
- Configurable metric keys and values
- OSAT by weekday tracking (Monday-Sunday breakdown)
- Multi-month range queries for trend analysis
- Bulk import capability
- Director-only access

**Database tables:** `scorecard_entries`, `scorecard_osat_weekday`

---

### 7. Social Media Posts

AI-powered social media content generator for Instagram and Facebook.

**How it works:**
- User selects a post type and provides key details (headline, context, CTA)
- System generates platform-specific copy using AI (tailored for IG and FB)
- Posts can include product photos and brand icons
- Brand voice, colors, and forbidden words are configurable

**Key features:**
- 5 post types: Weekly Special, LTO (Limited Time Offer), Community Event, Seasonal, Brand Moment
- Separate Instagram and Facebook copy generation
- AI-powered copy with brand voice consistency
- Product photo library with upload
- Icon library management (SVG icons for post designs)
- Brand configuration CMS (voice, colors, CTAs, disclaimers, forbidden words)
- Design template references
- Reference design upload for style guidance
- Regeneration capability for existing posts
- Post history and export logging

**Database tables:** `social_posts`, `social_icons`, `social_brand_config`, `social_product_photos`

---

### 8. Gastos (Invoice Entry Automation)

Invoice management system that bridges the gap between receiving vendor invoices and entering them into Chick-fil-A Inc.'s Oracle APEX expense system.

**How it works:**
1. Admin uploads an invoice photo/PDF
2. System runs OCR (via AI) to extract supplier, invoice number, date, line items, and amounts
3. AI suggests expense categories for each line item with confidence scores
4. Admin reviews and corrects OCR results, then saves the invoice
5. When ready, admin uses a browser bookmarklet to auto-fill the Inc. expense website (Oracle APEX)
6. The bookmarklet walks through a 3-page flow: supplier/month → invoice details → line items → submit
7. After submission, the system captures the Payment ID from Inc. and stamps it on exported PDF receipts

**Key features:**
- Invoice upload with OCR (supports JPG, PNG, PDF)
- AI-powered line item categorization with confidence scores
- 400+ pre-seeded suppliers (restaurant vendors, airlines, utilities, office supplies, etc.)
- 100+ bilingual expense categories (English + Spanish names)
- Status workflow: Draft → Ready → Submitted → Verified (with Error state)
- Browser bookmarklet for automated Oracle APEX entry (cross-origin, token-authenticated)
- Payment ID capture and tracking
- Manual Payment ID entry for previously submitted invoices
- Invoice detail view with line item editing
- Analytics dashboard (by supplier, category, month)
- Excel export of invoice data
- PDF receipt export with Payment ID stamp
- Month filter based on payment date
- XSS-safe rendering with escape helper
- UTC-safe date formatting

**Bookmarklet architecture:**
- Separate token-based auth system (not session-based, for cross-origin use)
- 24-hour token TTL with automatic cleanup
- 3-page APEX flow automation using `$s()` and `apex.submit()`
- SessionStorage persistence across page reloads for Payment ID capture

**Database tables:** `gastos_suppliers`, `gastos_expense_categories`, `gastos_invoices`, `gastos_invoice_lines`, `gastos_submission_log`

---

### 9. Reconciliation Reports

Monthly payroll reconciliation to verify hours, accruals, and time-off entries match.

**How it works:**
- Admin triggers a reconciliation run for a specific month
- System generates an HTML report comparing imported hours, calculated accruals, and recorded time-off
- Reports are archived for audit purposes

**Key features:**
- Automated comparison of hours vs. accruals vs. time-off
- HTML report generation and archival
- Download and deletion of past reports

**Database tables:** `reconciliation_reports`

---

### 10. Notification System

Configurable notification engine for employee communications.

**Key features:**
- Email notifications via SMTP (Nodemailer)
- Slack DM notifications via Bot API
- Milestone tracking (work anniversaries, accrual thresholds)
- Duplicate prevention (unique per employee + milestone)
- Configurable notification settings (enable/disable per type)
- Tardiness infraction alerts
- Time-off request status updates

**Database tables:** `notification_settings`, `milestone_notifications`

---

## Authentication & Authorization

### Role Hierarchy

| Role | Scope | Access |
|------|-------|--------|
| `admin` | System-level (users table) | Full admin portal, all modules |
| `Director` / `Senior Director` / `Shift Leader` | Employee-level (employees table) | Team management, reviews, evaluations, scorecard, social posts |
| `Trainer` | Employee-level | Read-only employee lists, AC evaluation submission |
| `Administrator` | Employee-level | Gastos module access |
| `Team Member` | Employee-level (default) | Own data only via employee portal |

### Security
- Bcrypt password hashing (10 rounds)
- PIN-based initial auth with mandatory password change
- Session-based auth with SQLite session store (8-hour TTL)
- Rate limiting on login (15 attempts / 15 minutes)
- Security headers (nosniff, SAMEORIGIN, XSS protection)
- Parameterized SQL queries throughout
- CSRF protection via SameSite cookies
- Token-based auth for bookmarklet (separate from sessions)

---

## Data Flow

### Import Sources
- **POS System:** Wage/hours Excel exports (monthly)
- **POS System:** Tardiness reports (bi-weekly)
- **POS System:** Meal penalty reports (as needed)
- **Manual Entry:** Performance reviews, AC evaluations, scorecard metrics
- **File Upload:** Invoice photos/PDFs, evidence files, product photos, icons
- **AI Services:** OCR for invoices, copy generation for social posts

### Export Targets
- **PDF:** Accrual statements, reconciliation reports, performance summaries, invoice receipts
- **Excel:** Invoice data, scorecard metrics, leadership progress
- **CSV:** Filtered accrual/employee data
- **Oracle APEX:** Automated invoice entry via bookmarklet
- **Email/Slack:** Notifications, alerts, weekly digests

---

## Technical Architecture

### Backend
- **Express.js** web server with middleware chain
- **better-sqlite3** for synchronous, fast database operations
- **WAL mode** for concurrent read access
- **22 schema migrations** with safety checks (idempotent, forward-only)
- **Seed data** for suppliers, categories, competency areas, checkpoints, learning resources
- **Multer** for file upload handling
- **pdf-lib** for PDF manipulation (merging, stamping)
- **xlsx** for Excel parsing and generation
- **pdfkit** for PDF generation
- **docx** for Word document generation
- **bcrypt** for password hashing
- **nodemailer** for email
- **Slack Web API** for DMs

### Frontend
- **Vanilla HTML/JS/CSS** (no framework)
- **Tab-based navigation** with conditional visibility based on role
- **Fetch API** with error handling wrapper
- **XSS-safe rendering** via escape helper
- **Responsive design** (works on desktop and mobile)
- **Drag & drop** file upload areas
- **Modal dialogs** for detail views and forms

### Infrastructure
- **DigitalOcean** droplet (Ubuntu)
- **PM2** process manager (auto-restart, log management)
- **Nginx** reverse proxy with SSL termination (Let's Encrypt)
- **SQLite** database files in `/opt/pto-tracker/data/`
- **Uploaded files** in `/opt/pto-tracker/uploads/`

---

## File Structure Summary

```
server/
  index.js              — Express app, auth middleware, route mounting (199 lines)
  db.js                 — Schema, 22 migrations, seed data (1,263 lines)
  routes/
    auth.js             — Login, logout, password management
    employees.js        — Employee CRUD, flagging
    accruals.js         — Accrual calculations, time-off recording
    requests.js         — Time-off request workflow
    imports.js          — Excel file upload and processing
    dashboard.js        — Summary statistics
    reports.js          — Data exports
    tardiness.js        — Tardiness report processing
    mealPenalty.js      — Meal penalty processing
    reconciliation.js   — Monthly reconciliation
    performanceReviews.js — Quarterly reviews
    acEvaluations.js    — AC evaluation CRUD
    leadershipAcademy.js — Full LA module (candidates, checkpoints, resources, analytics)
    scorecard.js        — Monthly KPI tracking
    socialPosts.js      — AI content generation, icons, brand config
    gastos.js           — Invoice management, bookmarklet auth, OCR
    notifications.js    — Alert configuration
  services/
    accrualEngine.js    — Accrual calculation logic
    emailService.js     — Email sending (Nodemailer)
    slackService.js     — Slack DM integration
    excelParser.js      — Wage/hours Excel parsing
    tardinessParser.js  — Tardiness report parsing
    mealPenaltyParser.js — Meal penalty parsing
  utils/
    constants.js        — Shared constants
    loadEnv.js          — Environment loader

public/
  index.html            — Admin portal (HTML structure + tabs)
  employee.html         — Employee portal (HTML + inline JS)
  login.html            — Login page
  js/
    app.js              — Admin dashboard logic (160 KB)
    login.js            — Auth flow (5 KB)
    scorecard.js        — Scorecard module (40 KB)
    social-posts.js     — Social media module (73 KB)
    gastos.js           — Invoice module (49 KB)
  css/
    style.css           — Unified stylesheet with CFA brand design system
  img/                  — Logos, backgrounds
  fonts/                — Apercu font family
```

---

## Current State

- **Production:** Live and in daily use at CFA La Rambla
- **Users:** ~130 employees with portal accounts, 5-6 admin/director users
- **Data:** Monthly imports running since launch, 400+ suppliers seeded, 100+ expense categories
- **Latest additions:** Gastos module with bookmarklet automation, Leadership Academy with evidence uploads, Payment ID capture

#!/usr/bin/env python3
"""
La Rambla — Monthly Reconciliation Script
Processes expense receipts and matches them against bank/credit card statements
"""

import pandas as pd
import json
from datetime import datetime, timedelta
from difflib import SequenceMatcher
import os
import sys
import argparse
import glob as globmod
import calendar

# ============================================================================
# CONFIGURATION
# ============================================================================

# Parse command-line arguments
parser = argparse.ArgumentParser(description='La Rambla Monthly Reconciliation')
parser.add_argument('--month', type=int, required=True, help='Month number (1-12)')
parser.add_argument('--year', type=int, required=True, help='Year (e.g. 2026)')
parser.add_argument('--uploads-dir', type=str, required=True, help='Directory containing input files')
parser.add_argument('--output-dir', type=str, required=True, help='Directory for generated HTML report')
parser.add_argument('--work-dir', type=str, required=True, help='Working directory for temp files')
args = parser.parse_args()

UPLOADS_DIR = args.uploads_dir
WORK_DIR = args.work_dir
OUTPUT_DIR = args.output_dir
RECON_STATE_DIR = os.path.join(OUTPUT_DIR, "recon_states")

PERIOD_MONTH = args.month
PERIOD_YEAR = args.year

MONTH_NAME = calendar.month_name[PERIOD_MONTH]
MONTH_ABBR = calendar.month_abbr[PERIOD_MONTH].lower()
PERIOD_KEY = f"{MONTH_ABBR}{PERIOD_YEAR}"  # e.g., "feb2026"

# Compute prior month for cross-month matching
if PERIOD_MONTH == 1:
    PRIOR_MONTH = 12
    PRIOR_YEAR = PERIOD_YEAR - 1
else:
    PRIOR_MONTH = PERIOD_MONTH - 1
    PRIOR_YEAR = PERIOD_YEAR
PRIOR_MONTH_ABBR = calendar.month_abbr[PRIOR_MONTH].lower()

print(f"=== La Rambla Reconciliation: {MONTH_NAME} {PERIOD_YEAR} ===")
print(f"  Period key: {PERIOD_KEY}")
print(f"  Prior month for cross-matching: {calendar.month_name[PRIOR_MONTH]} {PRIOR_YEAR}")

# Create output directories
os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(RECON_STATE_DIR, exist_ok=True)

def scan_existing_reconciliations():
    """Scan output directory for existing month reconciliation reports."""
    existing = []
    pattern = os.path.join(OUTPUT_DIR, "reconciliation_*.html")
    for filepath in sorted(globmod.glob(pattern)):
        fname = os.path.basename(filepath)
        # Extract period key from filename (e.g., "reconciliation_feb2026.html" → "feb2026")
        key = fname.replace("reconciliation_", "").replace(".html", "")
        # Parse month/year from key
        for i, m in enumerate(calendar.month_abbr):
            if m and key.startswith(m.lower()):
                year_str = key[len(m):]
                try:
                    yr = int(year_str)
                    existing.append({
                        'key': key,
                        'month': i,
                        'year': yr,
                        'label': f"{calendar.month_name[i]} {yr}",
                        'filename': fname,
                        'state_file': os.path.join(RECON_STATE_DIR, f"state_{key}.json"),
                    })
                except ValueError:
                    pass
                break
    return existing

# Vendor aliases for fuzzy matching
VENDOR_ALIASES = {
    'anthropic': ['claude.ai', 'anthropic', 'claude', 'digitalocean'],
    'consolidated waste': ['conwaste', 'consolidated waste', 'consolidated', 'consolidated waste sgurabo pr'],
    'walgreens': ['walgreens', 'walgreens #00700', 'wag'],
    'walmart': ['walmart', 'wm supercenter', 'wal-mart', 'walmart.com'],
    'meta': ['facebk', 'meta platform', 'meta', 'facebook'],
    'amazon': ['amazon', 'amazon marketplace', 'amzn', 'amazon marketplace na pa', 'amazon markeplace na pa'],
    'rentokil': ['rentokil', 'rentokil 000000001', 'rentokil 000000001 mayaguez pr'],
    'cadillac': ['cadillac uniform', 'cadillac uniforms'],
    'tres monjitas': ['vaqueria tres monjit', 'tres monjitas', 'vaqueria'],
    'microsoft': ['microsoft', 'microsoft msbill'],
    'adobe': ['adobe', 'adobe systems', 'pp*adobe'],
    'ycs pr': ['ycs pr corp', 'ycs pr'],
    'progressive': ['progressive', 'progressive finance'],
    'pli': ['pli card marketing', 'pli las vegas', 'pli card marketing solutions', 'pli las vegas llc north las veg nv'],
    't-mobile': ['t-mobile', 'tmobile*auto pay'],
    'claro': ['claro', 'claro msa', 'miclaro'],
    'luma': ['luma', 'aee', 'prepa', 'aee / prepa'],
    'aaa': ['acueductos y alcantarillados', 'aaa'],
    'marshalls': ['marshalls', 'marshalls #632'],
    'pf changs': ['pf changs', 'pf changs ponce'],
    'pueblo': ['pueblo', 'pueblo rambla'],
    'pizza heaven': ['pizza heaven', 'pizzas heaven'],
    'strong inc': ['strong inc', 'dmx dba mood media'],
    'workstream': ['workstream', 'workstream.us'],
    'vsbl': ['vsbl', 'jaywalking llc dba vsb'],
    'bravo cleaning': ['bravo cleaning'],
    'freshpoint': ['freshpoint', 'sysco corp', 'sysco'],
    'sysco': ['sysco corp', 'sysco', 'freshpoint'],
    'coca cola': ['coca cola', 'coca cola puerto rico', 'cc1 beer', 'cc1 beer bayamon'],
    'holsum': ['holsum', 'holsum de puerto rico'],
    'baskin robbins': ['baskin robbins'],
    'sherwin williams': ['sherwin williams', 'sherwin-williams'],
    'loomis': ['loomis'],
    'banco popular merchant': ['banco popular merchant', 'bppr merchant dr mbs fee', 'comm svc fee'],
    'triple s': ['triple s', 'triple-s'],
    'delta dental': ['delta dental'],
    'uber': ['uber eats', 'uber'],
    'texaco': ['texaco', 'texaco la rambla'],
    'pepe gangas': ['pepe gangas'],
}

# ============================================================================
# DATA LOADING
# ============================================================================

def load_expenses():
    """Load expense receipts CSV"""
    path = os.path.join(UPLOADS_DIR, "gastos.csv")
    df = pd.read_csv(path, encoding='utf-8')
    
    # Parse dates - format is "D-MMM-YY" like "3-Feb-26"
    df['PAYMENT_DATE'] = pd.to_datetime(df['PAYMENT_DATE'], format='%d-%b-%y', errors='coerce')
    df['INVOICE_DATE'] = pd.to_datetime(df['INVOICE_DATE'], format='%d-%b-%y', errors='coerce')
    
    # Filter to February 2026
    feb_mask = (df['PAYMENT_DATE'].dt.month == PERIOD_MONTH) & (df['PAYMENT_DATE'].dt.year == PERIOD_YEAR)
    df = df[feb_mask].reset_index(drop=True)
    
    # Clean amounts
    df['AMOUNT'] = pd.to_numeric(df['AMOUNT'], errors='coerce')
    
    return df

def load_chase():
    """Load Chase 4348 activity"""
    path = os.path.join(UPLOADS_DIR, "chase.csv")
    df = pd.read_csv(path)
    
    # Parse dates - use Transaction Date
    df['Transaction Date'] = pd.to_datetime(df['Transaction Date'], format='%m/%d/%Y', errors='coerce')
    df['Amount'] = pd.to_numeric(df['Amount'], errors='coerce')
    
    # Filter to February 2026 (transaction date)
    feb_mask = (df['Transaction Date'].dt.month == PERIOD_MONTH) & (df['Transaction Date'].dt.year == PERIOD_YEAR)
    df = df[feb_mask].reset_index(drop=True)
    
    # Add source and normalize amount (Chase shows negative for purchases)
    df['source'] = 'Chase Ink 4348'
    df['normalized_amount'] = df['Amount'].abs()
    
    return df

def load_amex_platinum():
    """Load AMEX Platinum activity"""
    path = os.path.join(UPLOADS_DIR, "amex_platinum.xlsx")
    df = pd.read_excel(path, header=None)
    
    # Use row 6 as header
    df.columns = df.iloc[6].values
    df = df.iloc[7:].reset_index(drop=True)
    
    # Rename columns for clarity
    df.columns = ['Date', 'Receipt', 'Description', 'Card Member', 'Account', 'Amount', 'Extended Details', 'Statement Name', 'col8', 'col9', 'col10', 'col11', 'col12', 'col13']
    
    # Parse dates
    df['Date'] = pd.to_datetime(df['Date'], format='%m/%d/%Y', errors='coerce')
    df['Amount'] = pd.to_numeric(df['Amount'], errors='coerce')
    
    # Filter to February 2026
    feb_mask = (df['Date'].dt.month == PERIOD_MONTH) & (df['Date'].dt.year == PERIOD_YEAR)
    df = df[feb_mask].reset_index(drop=True)
    
    # Add source and normalize amount (AMEX shows negative for charges)
    df['source'] = 'AMEX Platinum 62002'
    df['normalized_amount'] = df['Amount'].abs()
    
    return df

def load_amex_delta():
    """Load AMEX Delta activity"""
    path = os.path.join(UPLOADS_DIR, "amex_delta.xlsx")
    df = pd.read_excel(path, header=None)

    # Use row 6 as header
    df.columns = df.iloc[6].values
    df = df.iloc[7:].reset_index(drop=True)

    # Rename columns
    df.columns = ['Date', 'Receipt', 'Description', 'Card Member', 'Account', 'Amount', 'Extended Details', 'Statement Name', 'col8', 'col9', 'col10', 'col11', 'col12', 'col13']

    # Parse dates
    df['Date'] = pd.to_datetime(df['Date'], format='%m/%d/%Y', errors='coerce')
    df['Amount'] = pd.to_numeric(df['Amount'], errors='coerce')

    # Filter to February 2026
    feb_mask = (df['Date'].dt.month == PERIOD_MONTH) & (df['Date'].dt.year == PERIOD_YEAR)
    df = df[feb_mask].reset_index(drop=True)

    # Add source and normalize amount
    df['source'] = 'AMEX Delta 71003'
    df['normalized_amount'] = df['Amount'].abs()

    return df

# Bank debit categories to EXCLUDE from matching (meta-transactions)
BANK_EXCLUDED_PATTERNS = [
    'PORO GUSTO',           # Bulk vendor aggregate payments
    'CHICK FIL A PR',       # CFA corporate debits (royalties, marketing)
    'CHASE CREDIT CRD',     # CC bill payments
    'AMEX EPAYMENT',        # CC bill payments
    'BPPR CURRENCY CASH',   # Cash requests
    'AMERICAN EXPRESS AXP',  # AMEX discount fees
    'BPPR MERCHANT',        # BPPR merchant discount/MBS fees
]

def load_bank():
    """Load Banco Popular bank statement - debits only, excluding meta-transactions"""
    path = os.path.join(UPLOADS_DIR, "banco_current.csv")
    df = pd.read_csv(path)

    # Parse dates and amounts
    df['Date'] = pd.to_datetime(df['Date'], format='%m/%d/%Y', errors='coerce')
    df['Amount'] = pd.to_numeric(df['Amount'], errors='coerce')

    # Filter to February 2026
    feb_mask = (df['Date'].dt.month == PERIOD_MONTH) & (df['Date'].dt.year == PERIOD_YEAR)
    df = df[feb_mask].reset_index(drop=True)

    # Keep only debits (negative amounts)
    df = df[df['Amount'] < 0].reset_index(drop=True)

    # Exclude meta-transactions
    exclude_mask = pd.Series([False] * len(df))
    for pattern in BANK_EXCLUDED_PATTERNS:
        exclude_mask = exclude_mask | df['Description'].str.contains(pattern, case=False, na=False)
    df = df[~exclude_mask].reset_index(drop=True)

    # Add source and normalize amount
    df['source'] = 'Banco Popular'
    df['normalized_amount'] = df['Amount'].abs()

    return df

# ============================================================================
# MATCHING LOGIC
# ============================================================================

def fuzzy_match(str1, str2, threshold=0.6):
    """Fuzzy match two strings"""
    if not str1 or not str2:
        return 0.0
    s1 = str(str1).lower().strip()
    s2 = str(str2).lower().strip()
    return SequenceMatcher(None, s1, s2).ratio()

def normalize_vendor(vendor):
    """Normalize vendor name for matching"""
    if not vendor:
        return ""
    vendor_lower = str(vendor).lower().strip()
    
    # Check aliases - longest matches first
    for canonical, aliases in sorted(VENDOR_ALIASES.items(), key=lambda x: -max(len(a) for a in x[1])):
        for alias in aliases:
            if alias.lower() in vendor_lower or vendor_lower in alias.lower():
                return canonical
    
    return vendor_lower

def match_vendor(exp_vendor, stmt_vendor, threshold=0.65):
    """Match vendors with fuzzy logic"""
    exp_norm = normalize_vendor(exp_vendor)
    stmt_norm = normalize_vendor(stmt_vendor)
    
    # If normalized vendors match exactly
    if exp_norm and stmt_norm and exp_norm == stmt_norm:
        return 1.0
    
    # Fuzzy match on normalized names
    if exp_norm and stmt_norm:
        score = fuzzy_match(exp_norm, stmt_norm, threshold)
        if score >= threshold:
            return score
    
    # Fallback to original names - more lenient
    score = fuzzy_match(exp_vendor, stmt_vendor, 0.5)
    return score if score >= 0.5 else 0.0

def find_matches(expenses, chase_df, amex_plat_df, amex_delta_df, bank_df=None):
    """Match expenses to statement charges (CC + bank debits)"""
    
    matches = []
    matched_indices = set()
    
    for idx, exp in expenses.iterrows():
        exp_date = exp['PAYMENT_DATE']
        exp_amount = exp['AMOUNT']
        exp_vendor = exp['VENDOR']
        
        best_match = None
        best_tier = 5
        best_score = 0.0
        
        # Check Chase
        for chase_idx, chase in chase_df.iterrows():
            # Skip payments (positive amounts)
            if chase['Amount'] > 0:
                continue
            
            chase_date = chase['Transaction Date']
            chase_amount = chase['normalized_amount']
            chase_desc = chase['Description']
            
            days_diff = abs((exp_date - chase_date).days)
            
            # Check amount - allow $2 tolerance
            amount_diff = abs(chase_amount - exp_amount)
            if amount_diff > 2.0:
                continue
            
            # Vendor match
            vendor_score = match_vendor(exp_vendor, chase_desc, 0.65)

            # Tier assignment
            if vendor_score >= 0.65:
                if days_diff <= 3 and amount_diff < 0.01 and vendor_score >= 0.85:
                    tier = 1
                elif days_diff <= 5 and amount_diff < 0.01 and vendor_score >= 0.80:
                    tier = 2
                elif days_diff <= 7 and amount_diff < 0.01:
                    tier = 3
                elif days_diff <= 5 and amount_diff < 1.0 and vendor_score >= 0.75:
                    tier = 4
                elif days_diff <= 30 and amount_diff < 0.01 and vendor_score >= 0.85:
                    # Exact vendor + exact amount but wide date gap (delayed posting)
                    tier = 4
                else:
                    continue
            elif vendor_score >= 0.35 and days_diff <= 3 and amount_diff < 0.01:
                # Similar vendor name + exact amount + close date = Tier 4
                tier = 4
            else:
                continue
            
            if tier < best_tier or (tier == best_tier and vendor_score > best_score):
                best_tier = tier
                best_score = vendor_score
                best_match = {
                    'type': 'Credit Card',
                    'date': chase_date,
                    'amount': chase_amount,
                    'description': chase_desc,
                    'tier': tier,
                    'source': str(chase.get('source', 'Chase Ink 4348'))
                }
        
        # Check AMEX Platinum
        for amex_idx, amex in amex_plat_df.iterrows():
            amex_date = amex['Date']
            amex_amount = amex['normalized_amount']
            amex_desc = amex['Description']
            
            days_diff = abs((exp_date - amex_date).days)
            
            # Check amount - allow $2 tolerance
            amount_diff = abs(amex_amount - exp_amount)
            if amount_diff > 2.0:
                continue
            
            # Vendor match
            vendor_score = match_vendor(exp_vendor, amex_desc, 0.65)

            # Tier assignment
            if vendor_score >= 0.65:
                if days_diff <= 3 and amount_diff < 0.01 and vendor_score >= 0.85:
                    tier = 1
                elif days_diff <= 5 and amount_diff < 0.01 and vendor_score >= 0.80:
                    tier = 2
                elif days_diff <= 7 and amount_diff < 0.01:
                    tier = 3
                elif days_diff <= 5 and amount_diff < 1.0 and vendor_score >= 0.75:
                    tier = 4
                elif days_diff <= 30 and amount_diff < 0.01 and vendor_score >= 0.85:
                    # Exact vendor + exact amount but wide date gap (delayed posting)
                    tier = 4
                else:
                    continue
            elif vendor_score >= 0.35 and days_diff <= 3 and amount_diff < 0.01:
                # Similar vendor name + exact amount + close date = Tier 4
                tier = 4
            else:
                continue

            if tier < best_tier or (tier == best_tier and vendor_score > best_score):
                best_tier = tier
                best_score = vendor_score
                best_match = {
                    'type': 'Credit Card',
                    'date': amex_date,
                    'amount': amex_amount,
                    'description': amex_desc,
                    'tier': tier,
                    'source': str(amex.get('source', 'AMEX Platinum 62002'))
                }

        # Check AMEX Delta
        for amex_idx, amex in amex_delta_df.iterrows():
            amex_date = amex['Date']
            amex_amount = amex['normalized_amount']
            amex_desc = amex['Description']

            days_diff = abs((exp_date - amex_date).days)

            # Check amount - allow $2 tolerance
            amount_diff = abs(amex_amount - exp_amount)
            if amount_diff > 2.0:
                continue

            # Vendor match
            vendor_score = match_vendor(exp_vendor, amex_desc, 0.65)

            # Tier assignment
            if vendor_score >= 0.65:
                if days_diff <= 3 and amount_diff < 0.01 and vendor_score >= 0.85:
                    tier = 1
                elif days_diff <= 5 and amount_diff < 0.01 and vendor_score >= 0.80:
                    tier = 2
                elif days_diff <= 7 and amount_diff < 0.01:
                    tier = 3
                elif days_diff <= 5 and amount_diff < 1.0 and vendor_score >= 0.75:
                    tier = 4
                elif days_diff <= 30 and amount_diff < 0.01 and vendor_score >= 0.85:
                    # Exact vendor + exact amount but wide date gap (delayed posting)
                    tier = 4
                else:
                    continue
            elif vendor_score >= 0.35 and days_diff <= 3 and amount_diff < 0.01:
                # Similar vendor name + exact amount + close date = Tier 4
                tier = 4
            else:
                continue
            
            if tier < best_tier or (tier == best_tier and vendor_score > best_score):
                best_tier = tier
                best_score = vendor_score
                best_match = {
                    'type': 'Credit Card',
                    'date': amex_date,
                    'amount': amex_amount,
                    'description': amex_desc,
                    'tier': tier,
                    'source': str(amex.get('source', 'AMEX Delta 71003'))
                }

        # Check Banco Popular bank debits
        if bank_df is not None:
            for bank_idx, bank in bank_df.iterrows():
                bank_date = bank['Date']
                bank_amount = bank['normalized_amount']
                bank_desc = str(bank['Description'])

                days_diff = abs((exp_date - bank_date).days)

                # Check amount - allow $2 tolerance
                amount_diff = abs(bank_amount - exp_amount)
                if amount_diff > 2.0:
                    continue

                # Vendor match
                vendor_score = match_vendor(exp_vendor, bank_desc, 0.65)

                # Tier assignment
                if vendor_score >= 0.65:
                    if days_diff <= 3 and amount_diff < 0.01 and vendor_score >= 0.85:
                        tier = 1
                    elif days_diff <= 5 and amount_diff < 0.01 and vendor_score >= 0.80:
                        tier = 2
                    elif days_diff <= 7 and amount_diff < 0.01:
                        tier = 3
                    elif days_diff <= 5 and amount_diff < 1.0 and vendor_score >= 0.75:
                        tier = 4
                    elif days_diff <= 30 and amount_diff < 0.01 and vendor_score >= 0.85:
                        tier = 4
                    else:
                        continue
                elif vendor_score >= 0.35 and days_diff <= 3 and amount_diff < 0.01:
                    tier = 4
                elif days_diff <= 3 and amount_diff < 0.01 and exp_amount >= 50:
                    # Bank debits: exact amount + close date even with low vendor score
                    # (ATH Movil transfers have person names, not vendor names)
                    # Only for amounts >= $50 to avoid false positives on small common amounts
                    tier = 4
                else:
                    continue

                if tier < best_tier or (tier == best_tier and vendor_score > best_score):
                    best_tier = tier
                    best_score = vendor_score
                    best_match = {
                        'type': 'Bank Debit',
                        'date': bank_date,
                        'amount': bank_amount,
                        'description': bank_desc,
                        'tier': tier,
                        'source': str(bank.get('source', 'Banco Popular'))
                    }

        if best_match:
            matches.append({
                'expense_idx': idx,
                'exp_date': exp_date.strftime('%Y-%m-%d'),
                'exp_vendor': exp_vendor,
                'exp_amount': float(exp_amount),
                'exp_category': exp['EXPENSE_CATEGORY'],
                'match_date': best_match['date'].strftime('%Y-%m-%d'),
                'match_amount': float(best_match['amount']),
                'match_desc': best_match['description'],
                'match_type': best_match['type'],
                'match_source': best_match['source'],
                'tier': best_match['tier'],
                'status': 'matched'
            })
            matched_indices.add(idx)
    
    return matches, matched_indices

# ============================================================================
# MAIN PROCESSING
# ============================================================================

print("Loading data...")
expenses = load_expenses()
chase_df = load_chase()
amex_plat_df = load_amex_platinum()
amex_delta_df = load_amex_delta()
bank_df = load_bank()

# Load January statements for cross-month matching
jan_chase_path = os.path.join(WORK_DIR, 'jan_chase.csv')
jan_amex_plat_path = os.path.join(WORK_DIR, 'jan_amex_plat.csv')
jan_amex_delta_path = os.path.join(WORK_DIR, 'jan_amex_delta.csv')
jan_bank_path = os.path.join(UPLOADS_DIR, 'banco_prior.csv')

jan_count = 0
if os.path.exists(jan_chase_path):
    jan_chase = pd.read_csv(jan_chase_path)
    jan_chase['Transaction Date'] = pd.to_datetime(jan_chase['Transaction Date'], format='%m/%d/%Y', errors='coerce')
    jan_chase['Amount'] = pd.to_numeric(jan_chase['Amount'], errors='coerce')
    jan_chase['source'] = 'Chase Ink 4348 (Jan)'
    jan_chase['normalized_amount'] = jan_chase['Amount'].abs()
    # Append to chase_df
    chase_df = pd.concat([chase_df, jan_chase], ignore_index=True)
    jan_count += len(jan_chase)

if os.path.exists(jan_amex_plat_path):
    jan_plat = pd.read_csv(jan_amex_plat_path)
    jan_plat['Date'] = pd.to_datetime(jan_plat['Date'], format='%m/%d/%Y', errors='coerce')
    jan_plat['Amount'] = pd.to_numeric(jan_plat['Amount'], errors='coerce')
    jan_plat['source'] = 'AMEX Platinum 62002 (Jan)'
    jan_plat['normalized_amount'] = jan_plat['Amount'].abs()
    amex_plat_df = pd.concat([amex_plat_df, jan_plat], ignore_index=True)
    jan_count += len(jan_plat)

if os.path.exists(jan_amex_delta_path):
    jan_delta = pd.read_csv(jan_amex_delta_path)
    jan_delta['Date'] = pd.to_datetime(jan_delta['Date'], format='%m/%d/%Y', errors='coerce')
    jan_delta['Amount'] = pd.to_numeric(jan_delta['Amount'], errors='coerce')
    jan_delta['source'] = 'AMEX Delta 71003 (Jan)'
    jan_delta['normalized_amount'] = jan_delta['Amount'].abs()
    amex_delta_df = pd.concat([amex_delta_df, jan_delta], ignore_index=True)
    jan_count += len(jan_delta)

if os.path.exists(jan_bank_path):
    jan_bank = pd.read_csv(jan_bank_path)
    jan_bank['Date'] = pd.to_datetime(jan_bank['Date'], format='%m/%d/%Y', errors='coerce')
    jan_bank['Amount'] = pd.to_numeric(jan_bank['Amount'], errors='coerce')
    # Keep only debits, exclude meta-transactions
    jan_bank = jan_bank[jan_bank['Amount'] < 0].reset_index(drop=True)
    exclude_mask = pd.Series([False] * len(jan_bank))
    for pattern in BANK_EXCLUDED_PATTERNS:
        exclude_mask = exclude_mask | jan_bank['Description'].str.contains(pattern, case=False, na=False)
    jan_bank = jan_bank[~exclude_mask].reset_index(drop=True)
    jan_bank['source'] = 'Banco Popular (Jan)'
    jan_bank['normalized_amount'] = jan_bank['Amount'].abs()
    bank_df = pd.concat([bank_df, jan_bank], ignore_index=True)
    jan_count += len(jan_bank)

print(f"Expenses: {len(expenses)}")
print(f"Chase (Feb+Jan): {len(chase_df)}")
print(f"AMEX Plat (Feb+Jan): {len(amex_plat_df)}")
print(f"AMEX Delta (Feb+Jan): {len(amex_delta_df)}")
print(f"Bank debits (Feb+Jan): {len(bank_df)}")
print(f"January transactions added: {jan_count}")

print("\nMatching expenses to statements...")
matches, matched_indices = find_matches(expenses, chase_df, amex_plat_df, amex_delta_df, bank_df)

print(f"Matched: {len(matches)}")
print(f"Unmatched: {len(expenses) - len(matched_indices)}")

# Build unmatched expenses - separate bulk vendors vs others
BULK_VENDORS = ['COCA COLA PUERTO RICO', 'FRESHPOINT', 'HOLSUM DE PUERTO RICO', 'PR COFFEE ROASTERS', 'TRES MONJITAS']

unmatched_expenses_bulk = []
unmatched_expenses_other = []
for idx, exp in expenses.iterrows():
    if idx not in matched_indices:
        item = {
            'expense_idx': idx,
            'date': exp['PAYMENT_DATE'].strftime('%Y-%m-%d'),
            'vendor': exp['VENDOR'],
            'amount': float(exp['AMOUNT']),
            'category': exp['EXPENSE_CATEGORY'],
            'invoice': str(exp['INVOICE_NUMBER']) if pd.notna(exp['INVOICE_NUMBER']) else '',
            'description': str(exp['DESCRIPTION'])[:100] if pd.notna(exp['DESCRIPTION']) else ''
        }
        if exp['VENDOR'].strip() in BULK_VENDORS:
            unmatched_expenses_bulk.append(item)
        else:
            unmatched_expenses_other.append(item)

# Build unmatched CC/bank charges (charges on statements with no matching expense)
matched_cc_keys = set()
for m in matches:
    matched_cc_keys.add((m['match_source'], m['match_date'], m['match_amount']))

unmatched_cc_charges = []

# Chase unmatched (Feb only — Jan data is for matching only)
for _, row in chase_df.iterrows():
    if row['Amount'] >= 0:
        continue  # skip payments
    if '(Jan)' in str(row.get('source', '')):
        continue  # skip January transactions from unmatched list
    key = ('Chase Ink 4348', row['Transaction Date'].strftime('%Y-%m-%d'), float(row['normalized_amount']))
    if key not in matched_cc_keys:
        unmatched_cc_charges.append({
            'date': row['Transaction Date'].strftime('%Y-%m-%d'),
            'description': str(row['Description']),
            'amount': float(row['normalized_amount']),
            'source': 'Chase Ink 4348',
            'category': str(row.get('Category', ''))
        })

# AMEX Platinum unmatched (Feb only)
for _, row in amex_plat_df.iterrows():
    if row['Amount'] < 0:
        continue  # skip payments/credits
    if '(Jan)' in str(row.get('source', '')):
        continue  # skip January transactions from unmatched list
    key = ('AMEX Platinum 62002', row['Date'].strftime('%Y-%m-%d'), float(row['normalized_amount']))
    if key not in matched_cc_keys:
        desc = row.get('Description', '')
        if pd.isna(desc):
            desc = row.get('Receipt', '')
        if pd.isna(desc):
            desc = ''
        unmatched_cc_charges.append({
            'date': row['Date'].strftime('%Y-%m-%d'),
            'description': str(desc)[:80],
            'amount': float(row['normalized_amount']),
            'source': 'AMEX Platinum 62002',
            'category': str(row.get('col13', '')) if pd.notna(row.get('col13', '')) else ''
        })

# AMEX Delta unmatched (Feb only)
for _, row in amex_delta_df.iterrows():
    if row['Amount'] < 0:
        continue  # skip payments/credits
    if '(Jan)' in str(row.get('source', '')):
        continue  # skip January transactions from unmatched list
    key = ('AMEX Delta 71003', row['Date'].strftime('%Y-%m-%d'), float(row['normalized_amount']))
    if key not in matched_cc_keys:
        desc = row.get('Description', '')
        if pd.isna(desc):
            desc = row.get('Receipt', '')
        if pd.isna(desc):
            desc = ''
        unmatched_cc_charges.append({
            'date': row['Date'].strftime('%Y-%m-%d'),
            'description': str(desc)[:80],
            'amount': float(row['normalized_amount']),
            'source': 'AMEX Delta 71003',
            'category': str(row.get('col13', '')) if pd.notna(row.get('col13', '')) else ''
        })

# Banco Popular bank debits unmatched (Feb only)
for _, row in bank_df.iterrows():
    if '(Jan)' in str(row.get('source', '')):
        continue  # skip January transactions from unmatched list
    key = ('Banco Popular', row['Date'].strftime('%Y-%m-%d'), float(row['normalized_amount']))
    if key not in matched_cc_keys:
        unmatched_cc_charges.append({
            'date': row['Date'].strftime('%Y-%m-%d'),
            'description': str(row['Description'])[:80],
            'amount': float(row['normalized_amount']),
            'source': 'Banco Popular',
            'category': ''
        })

# Classify CC charges by bulk vendor for inclusion in vendor panels
BULK_VENDOR_CANONICAL = {
    'coca cola': ['COCA COLA PUERTO RICO'],
    'freshpoint': ['FRESHPOINT'],
    'sysco': ['FRESHPOINT'],         # Sysco = Freshpoint parent company
    'holsum': ['HOLSUM DE PUERTO RICO'],
    'pr coffee': ['PR COFFEE ROASTERS'],
    'tres monjitas': ['TRES MONJITAS'],
    'cc1 beer': ['COCA COLA PUERTO RICO', 'PR COFFEE ROASTERS'],  # CC statement name for both vendors
}

cc_by_vendor = {v: [] for v in BULK_VENDORS}
cc_non_bulk = []  # CC charges not related to any bulk vendor

# Filter out micro-charges < $4 and classify by vendor
MIN_CC_AMOUNT = 4.00

for cc in unmatched_cc_charges:
    if cc['amount'] < MIN_CC_AMOUNT:
        continue  # Skip micro-charges
    desc = cc['description']
    normalized = normalize_vendor(desc)
    assigned = False
    # Check against bulk vendor canonical mappings (supports multi-vendor assignment)
    for key, vendor_names in BULK_VENDOR_CANONICAL.items():
        if key in normalized or key in desc.lower():
            for vn in vendor_names:
                cc_by_vendor[vn].append(cc)
            assigned = True
            break
    if not assigned:
        cc_non_bulk.append(cc)

# Count filtered charges
filtered_count = len([c for c in unmatched_cc_charges if c['amount'] < MIN_CC_AMOUNT])
if filtered_count:
    print(f"  Filtered out {filtered_count} CC charges < ${MIN_CC_AMOUNT:.2f}")

# Print classification results
for v in BULK_VENDORS:
    if cc_by_vendor[v]:
        print(f"  CC charges for {v}: {len(cc_by_vendor[v])}")
        for c in cc_by_vendor[v]:
            print(f"    {c['date']} ${c['amount']:,.2f} {c['description'][:50]}")

print(f"  CC charges not related to bulk vendors: {len(cc_non_bulk)}")

# Calculate summary statistics
total_expenses = expenses['AMOUNT'].sum()
matched_amount = sum(m['exp_amount'] for m in matches)
unmatched_amount = total_expenses - matched_amount
matched_pct = (len(matches) / len(expenses) * 100) if len(expenses) > 0 else 0

all_unmatched_expenses = unmatched_expenses_bulk + unmatched_expenses_other

summary = {
    'period': f'February {PERIOD_YEAR}',
    'total_expenses': float(total_expenses),
    'total_transactions': len(expenses),
    'total_matched': len(matches),
    'total_unmatched': len(all_unmatched_expenses),
    'unmatched_bulk': len(unmatched_expenses_bulk),
    'unmatched_other': len(unmatched_expenses_other),
    'unmatched_cc': len(unmatched_cc_charges),
    'matched_percentage': round(matched_pct, 2),
    'matched_amount': float(matched_amount),
    'unmatched_amount': float(unmatched_amount),
    'bulk_amount': float(sum(e['amount'] for e in unmatched_expenses_bulk)),
    'other_unmatched_amount': float(sum(e['amount'] for e in unmatched_expenses_other)),
    'cc_unmatched_amount': float(sum(c['amount'] for c in unmatched_cc_charges)),
    'chase_charges': len(chase_df[chase_df['Amount'] < 0]),
    'amex_plat_charges': len(amex_plat_df),
    'amex_delta_charges': len(amex_delta_df),
}

# Category breakdown
category_breakdown = expenses.groupby('EXPENSE_CATEGORY')['AMOUNT'].sum().to_dict()
category_breakdown = {k: float(v) for k, v in sorted(category_breakdown.items(), key=lambda x: x[1], reverse=True)}

# Tier breakdown
tier_counts = {}
tier_amounts = {}
for m in matches:
    tier = m['tier']
    tier_key = f'Tier {tier}'
    tier_counts[tier_key] = tier_counts.get(tier_key, 0) + 1
    tier_amounts[tier_key] = tier_amounts.get(tier_key, 0) + m['exp_amount']

# Per-card summary
card_summary = {
    'Chase Ink 4348': {
        'count': len(chase_df[chase_df['Amount'] < 0]),
        'total': float(abs(chase_df[chase_df['Amount'] < 0]['Amount'].sum())) if len(chase_df) > 0 else 0.0
    },
    'AMEX Platinum 62002': {
        'count': len(amex_plat_df),
        'total': float(amex_plat_df['normalized_amount'].sum()) if len(amex_plat_df) > 0 else 0.0
    },
    'AMEX Delta 71003': {
        'count': len(amex_delta_df),
        'total': float(amex_delta_df['normalized_amount'].sum()) if len(amex_delta_df) > 0 else 0.0
    }
}

# Group bulk expenses by vendor for per-vendor tabs
bulk_by_vendor = {}
for vendor_name in BULK_VENDORS:
    bulk_by_vendor[vendor_name] = [e for e in unmatched_expenses_bulk if e['vendor'].strip() == vendor_name]

# Per-vendor summary stats
bulk_vendor_summary = {}
for vendor_name in BULK_VENDORS:
    vendor_items = bulk_by_vendor[vendor_name]
    bulk_vendor_summary[vendor_name] = {
        'count': len(vendor_items),
        'total': sum(e['amount'] for e in vendor_items),
    }

# ============================================================================
# VENDOR INVOICE LOADING (supports CSV, Excel, and PDF)
# ============================================================================
INVOICE_DIR = UPLOADS_DIR

# Map vendor names to possible filename patterns (without extension)
VENDOR_FILE_PATTERNS = {
    'COCA COLA PUERTO RICO': ['invoice_cocacola', 'cocacola', 'coca_cola', 'coca cola'],
    'FRESHPOINT': ['invoice_freshpoint', 'freshpoint', 'fresh_point'],
    'HOLSUM DE PUERTO RICO': ['invoice_holsum', 'holsum'],
    'PR COFFEE ROASTERS': ['invoice_prcoffee', 'prcoffee', 'pr_coffee', 'coffee_roasters'],
    'TRES MONJITAS': ['invoice_tresmonjitas', 'tresmonjitas', 'tres_monjitas'],
}

def find_invoice_file(vendor_name):
    """Find invoice file for a vendor, checking CSV, XLSX, and PDF extensions."""
    patterns = VENDOR_FILE_PATTERNS.get(vendor_name, [])
    extensions = ['.csv', '.xlsx', '.xls', '.pdf']

    # Check exact pattern matches first
    for pattern in patterns:
        for ext in extensions:
            filepath = os.path.join(INVOICE_DIR, pattern + ext)
            if os.path.exists(filepath):
                return filepath, ext

    # Also scan directory for files containing vendor keywords
    vendor_keywords = vendor_name.lower().replace(' de puerto rico', '').replace(' puerto rico', '').split()
    try:
        for fname in os.listdir(INVOICE_DIR):
            fname_lower = fname.lower()
            if any(kw in fname_lower for kw in vendor_keywords if len(kw) > 3):
                for ext in extensions:
                    if fname_lower.endswith(ext) and 'invoice' in fname_lower:
                        return os.path.join(INVOICE_DIR, fname), ext
    except:
        pass

    return None, None

def extract_invoice_from_pdf(filepath, vendor_name):
    """Extract line items from a vendor invoice PDF using tabula or regex parsing."""
    items = []
    try:
        # Try tabula-py first for table extraction
        import tabula
        tables = tabula.read_pdf(filepath, pages='all', multiple_tables=True, lattice=True)
        if not tables:
            tables = tabula.read_pdf(filepath, pages='all', multiple_tables=True, stream=True)

        for df in tables:
            if len(df.columns) < 2:
                continue
            # Try to identify amount column (numeric) and date column
            for _, row in df.iterrows():
                row_vals = [str(v) for v in row.values if pd.notna(v)]
                # Look for rows with a dollar amount
                for val in row_vals:
                    cleaned = val.replace('$', '').replace(',', '').strip()
                    try:
                        amount = float(cleaned)
                        if 1.0 < amount < 50000:  # reasonable invoice amount
                            items.append({
                                'date': '',
                                'invoice_number': '',
                                'amount': amount,
                                'description': ' | '.join(row_vals[:3])[:100],
                                'matched': False,
                                'match_idx': None,
                                'source_file': os.path.basename(filepath),
                            })
                            break
                    except ValueError:
                        continue
    except ImportError:
        print(f"    tabula-py not available, trying basic PDF text extraction...")
        try:
            import subprocess
            result = subprocess.run(['pdftotext', '-layout', filepath, '-'], capture_output=True, text=True)
            if result.returncode == 0:
                import re
                lines = result.stdout.split('\n')
                for line in lines:
                    # Look for lines with dollar amounts
                    amounts = re.findall(r'\$?([\d,]+\.\d{2})\b', line)
                    for amt_str in amounts:
                        try:
                            amount = float(amt_str.replace(',', ''))
                            if 1.0 < amount < 50000:
                                items.append({
                                    'date': '',
                                    'invoice_number': '',
                                    'amount': amount,
                                    'description': line.strip()[:100],
                                    'matched': False,
                                    'match_idx': None,
                                    'source_file': os.path.basename(filepath),
                                })
                        except:
                            continue
        except Exception as e:
            print(f"    PDF text extraction failed: {e}")
    except Exception as e:
        print(f"    PDF table extraction failed: {e}")

    return items

def load_tabular_invoice(filepath, ext):
    """Load invoice items from CSV or Excel file."""
    items = []
    try:
        if ext == '.csv':
            df = pd.read_csv(filepath)
        else:  # .xlsx, .xls
            df = pd.read_excel(filepath)

        # Normalize column names (case-insensitive matching)
        col_map = {}
        for col in df.columns:
            cl = str(col).lower().strip()
            if cl in ('date', 'fecha', 'invoice_date', 'inv_date', 'invoice date'):
                col_map['date'] = col
            elif cl in ('invoice_number', 'invoice', 'inv_no', 'invoice #', 'invoice_no', 'numero', 'factura'):
                col_map['invoice_number'] = col
            elif cl in ('amount', 'total', 'monto', 'amt', 'net_amount', 'net amount', 'importe'):
                col_map['amount'] = col
            elif cl in ('description', 'desc', 'item', 'descripcion', 'detail', 'details', 'product'):
                col_map['description'] = col

        for _, row in df.iterrows():
            date_val = str(row.get(col_map.get('date', 'date'), '')) if 'date' in col_map else ''
            inv_val = str(row.get(col_map.get('invoice_number', 'invoice_number'), '')) if 'invoice_number' in col_map else ''
            desc_val = str(row.get(col_map.get('description', 'description'), '')) if 'description' in col_map else ''

            # Get amount — try mapped column first, then scan for numeric
            amount = 0.0
            if 'amount' in col_map:
                raw_amt = row.get(col_map['amount'], 0)
                if pd.notna(raw_amt):
                    try:
                        amount = float(str(raw_amt).replace('$', '').replace(',', ''))
                    except:
                        amount = 0.0

            if amount > 0:
                # Clean date
                if date_val and date_val != 'nan':
                    try:
                        parsed_date = pd.to_datetime(date_val, errors='coerce')
                        if pd.notna(parsed_date):
                            date_val = parsed_date.strftime('%Y-%m-%d')
                    except:
                        pass
                else:
                    date_val = ''

                items.append({
                    'date': date_val if date_val != 'nan' else '',
                    'invoice_number': inv_val if inv_val != 'nan' else '',
                    'amount': amount,
                    'description': desc_val[:100] if desc_val != 'nan' else '',
                    'matched': False,
                    'match_idx': None,
                    'source_file': os.path.basename(filepath),
                })
    except Exception as e:
        print(f"    Error loading tabular invoice: {e}")

    return items

def load_vendor_invoices():
    """Scan for vendor invoice files (CSV, Excel, PDF) and load them."""
    invoice_data = {}

    for vendor_name in BULK_VENDORS:
        filepath, ext = find_invoice_file(vendor_name)
        if filepath:
            print(f"  Found invoice for {vendor_name}: {os.path.basename(filepath)}")
            if ext == '.pdf':
                items = extract_invoice_from_pdf(filepath, vendor_name)
            else:
                items = load_tabular_invoice(filepath, ext)
            invoice_data[vendor_name] = items
            print(f"    Loaded {len(items)} line items")
        else:
            invoice_data[vendor_name] = []

    return invoice_data

def match_bulk_to_invoices(bulk_by_vendor, invoice_data):
    """Match GASTOS bulk entries to vendor invoice line items by exact amount + close date."""
    bulk_matches = []
    for vendor_name in BULK_VENDORS:
        gastos_items = bulk_by_vendor.get(vendor_name, [])
        invoices = invoice_data.get(vendor_name, [])
        if not invoices:
            continue
        used_invoice_idx = set()
        for g_idx, g in enumerate(gastos_items):
            g_date = datetime.strptime(g['date'], '%Y-%m-%d')
            for inv_idx, inv in enumerate(invoices):
                if inv_idx in used_invoice_idx:
                    continue
                try:
                    inv_date = datetime.strptime(inv['date'], '%Y-%m-%d')
                except:
                    continue
                amount_diff = abs(g['amount'] - inv['amount'])
                days_diff = abs((g_date - inv_date).days)
                if amount_diff < 0.01 and days_diff <= 3:
                    bulk_matches.append({
                        'vendor': vendor_name,
                        'gastos_idx': g_idx,
                        'invoice_idx': inv_idx,
                        'gastos_date': g['date'],
                        'invoice_date': inv['date'],
                        'amount': g['amount'],
                        'gastos_invoice': g.get('invoice', ''),
                        'vendor_invoice': inv.get('invoice_number', ''),
                        'days_diff': days_diff,
                    })
                    invoices[inv_idx]['matched'] = True
                    invoices[inv_idx]['match_idx'] = g_idx
                    used_invoice_idx.add(inv_idx)
                    break
    return bulk_matches

print("\nLoading vendor invoices...")
invoice_data = load_vendor_invoices()
bulk_invoice_matches = match_bulk_to_invoices(bulk_by_vendor, invoice_data)
print(f"  Bulk invoice matches: {len(bulk_invoice_matches)}")

# Update bulk vendor summary with match counts
for vendor_name in BULK_VENDORS:
    vendor_matches = [m for m in bulk_invoice_matches if m['vendor'] == vendor_name]
    bulk_vendor_summary[vendor_name]['matched'] = len(vendor_matches)
    bulk_vendor_summary[vendor_name]['invoice_count'] = len(invoice_data.get(vendor_name, []))

print(f"\nSummary:")
print(f"  Total Expenses: ${total_expenses:,.2f}")
print(f"  Matched: {len(matches)} ({matched_pct:.1f}%)")
print(f"  Unmatched Gastos (bulk vendors): {len(unmatched_expenses_bulk)}")
print(f"  Unmatched Gastos (other): {len(unmatched_expenses_other)}")
print(f"  Unmatched CC/Bank charges: {len(unmatched_cc_charges)}")
print(f"\nTier breakdown:")
for tier_key in sorted(tier_counts.keys()):
    print(f"  {tier_key}: {tier_counts[tier_key]} matches (${tier_amounts[tier_key]:,.2f})")

# ============================================================================
# MONTH NAVIGATION & STATE MANAGEMENT
# ============================================================================

existing_recons = scan_existing_reconciliations()

def generate_month_selector():
    """Generate a styled dropdown with all 12 months of the current year pre-populated.
    Available months (with existing HTML reports) are selectable; others are disabled."""
    # Build a set of available month keys from existing reports
    available_keys = {r['key']: r['filename'] for r in existing_recons}
    # Always include current period as available
    available_keys[PERIOD_KEY] = f'reconciliation_{PERIOD_KEY}.html'

    option_tags = []
    for month_num in range(1, 13):
        abbr = calendar.month_abbr[month_num].lower()
        key = f'{abbr}{PERIOD_YEAR}'
        label = f'{calendar.month_name[month_num]} {PERIOD_YEAR}'
        is_current = key == PERIOD_KEY
        is_available = key in available_keys

        if is_current:
            option_tags.append(f'<option value="" selected>{label}</option>')
        elif is_available:
            option_tags.append(f'<option value="{available_keys[key]}">{label}</option>')
        else:
            option_tags.append(f'<option value="" disabled style="color:#d1d5db;">{label} — no data</option>')

    options_html = '\n'.join(option_tags)

    return f'''<div style="display:flex; align-items:center; gap:8px;">
        <label for="monthSelector" style="font-size:0.8rem; font-weight:600; color:#6b7280; white-space:nowrap;">Period:</label>
        <select id="monthSelector" onchange="if(this.value) window.location.href=this.value;"
            style="padding:8px 32px 8px 14px; border:2px solid #d1d5db; border-radius:8px; font-size:0.9rem; font-weight:600; color:#1e40af; background:white; cursor:pointer; appearance:none; -webkit-appearance:none; background-image:url('data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'12\\' height=\\'12\\' viewBox=\\'0 0 24 24\\' fill=\\'none\\' stroke=\\'%236b7280\\' stroke-width=\\'3\\' stroke-linecap=\\'round\\' stroke-linejoin=\\'round\\'><polyline points=\\'6 9 12 15 18 9\\'></polyline></svg>'); background-repeat:no-repeat; background-position:right 10px center; min-width:200px;">
            {options_html}
        </select>
    </div>'''

# Pre-compute month options JSON for JavaScript embedding
_month_options = []
for _m in range(1, 13):
    if _m != PERIOD_MONTH:
        _month_options.append({
            "key": f"{calendar.month_abbr[_m].lower()}{PERIOD_YEAR}",
            "label": f"{calendar.month_name[_m]} {PERIOD_YEAR}",
            "num": _m
        })
MONTH_OPTIONS_JSON = json.dumps(_month_options)

# ============================================================================
# HTML GENERATION (Enhanced with filter/sort/separated sections)
# ============================================================================

html_content = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>La Rambla - {MONTH_NAME} {PERIOD_YEAR} Reconciliation</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
    <style>
        body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; }}
        .card {{ box-shadow: 0 1px 3px rgba(0,0,0,0.1); border-radius: 0.5rem; }}
        .tier-badge {{ font-size: 0.75rem; font-weight: 600; padding: 0.25rem 0.75rem; border-radius: 9999px; display: inline-block; }}
        .tier-1 {{ background-color: #d1fae5; color: #065f46; }}
        .tier-2 {{ background-color: #bfdbfe; color: #1e40af; }}
        .tier-3 {{ background-color: #fef3c7; color: #92400e; }}
        .tier-4 {{ background-color: #fed7aa; color: #92400e; }}
        .source-chase {{ background-color: #dbeafe; color: #1e40af; font-size: 0.7rem; padding: 2px 8px; border-radius: 9999px; }}
        .source-plat {{ background-color: #d1fae5; color: #065f46; font-size: 0.7rem; padding: 2px 8px; border-radius: 9999px; }}
        .source-delta {{ background-color: #ffedd5; color: #9a3412; font-size: 0.7rem; padding: 2px 8px; border-radius: 9999px; }}
        table {{ width: 100%; border-collapse: collapse; font-size: 0.875rem; }}
        th {{ background-color: #f3f4f6; text-align: left; padding: 10px 12px; border-bottom: 2px solid #d1d5db; font-weight: 600; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: #374151; }}
        td {{ padding: 10px 12px; border-bottom: 1px solid #e5e7eb; }}
        tr:hover {{ background-color: #f9fafb; }}
        .sortable {{ cursor: pointer; user-select: none; position: relative; padding-right: 20px; }}
        .sortable:hover {{ background-color: #e5e7eb; }}
        .sortable::after {{ content: '⇅'; position: absolute; right: 4px; color: #9ca3af; font-size: 0.7rem; }}
        .sort-asc::after {{ content: '↑'; color: #2563eb; }}
        .sort-desc::after {{ content: '↓'; color: #2563eb; }}
        .chart-container {{ position: relative; height: 300px; margin-bottom: 2rem; }}
        .filter-bar {{ display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; padding: 12px; background: #f9fafb; border-radius: 8px; border: 1px solid #e5e7eb; }}
        .filter-bar input, .filter-bar select {{ padding: 6px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.85rem; background: white; }}
        .filter-bar input:focus, .filter-bar select:focus {{ outline: none; border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,0.2); }}
        .filter-bar label {{ font-size: 0.8rem; font-weight: 600; color: #4b5563; }}
        .tab-btn {{ padding: 8px 20px; font-size: 0.85rem; font-weight: 600; border: 1px solid #d1d5db; background: white; cursor: pointer; transition: all 0.15s; }}
        .tab-btn:first-child {{ border-radius: 8px 0 0 8px; }}
        .tab-btn:last-child {{ border-radius: 0 8px 8px 0; }}
        .tab-btn.active {{ background: #2563eb; color: white; border-color: #2563eb; }}
        .tab-btn:hover:not(.active) {{ background: #f3f4f6; }}
        .section-count {{ font-size: 0.8rem; background: #e5e7eb; color: #374151; padding: 2px 8px; border-radius: 9999px; margin-left: 8px; }}
        .tab-btn.active .section-count {{ background: rgba(255,255,255,0.3); color: white; }}
        .vendor-tag {{ display: inline-block; font-size: 0.7rem; padding: 2px 8px; border-radius: 9999px; font-weight: 600; }}
        .vendor-coca {{ background: #fee2e2; color: #991b1b; }}
        .vendor-fresh {{ background: #dcfce7; color: #166534; }}
        .vendor-holsum {{ background: #fef3c7; color: #92400e; }}
        .vendor-coffee {{ background: #e0e7ff; color: #3730a3; }}
        .vendor-monjitas {{ background: #fce7f3; color: #9d174d; }}
        .hidden {{ display: none; }}
        .main-tab-bar {{ display: flex; gap: 0; margin-bottom: 24px; }}
        .main-tab {{ padding: 12px 28px; font-size: 0.95rem; font-weight: 700; border: 2px solid #d1d5db; background: white; cursor: pointer; transition: all 0.15s; color: #4b5563; }}
        .main-tab:first-child {{ border-radius: 10px 0 0 10px; }}
        .main-tab:last-child {{ border-radius: 0 10px 10px 0; border-left: none; }}
        .main-tab.active {{ background: #1e40af; color: white; border-color: #1e40af; }}
        .main-tab:hover:not(.active) {{ background: #f3f4f6; }}
        .main-tab .tab-count {{ font-size: 0.75rem; background: rgba(0,0,0,0.1); padding: 2px 8px; border-radius: 9999px; margin-left: 8px; }}
        .main-tab.active .tab-count {{ background: rgba(255,255,255,0.25); }}
        .vendor-sub-tabs {{ display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }}
        .vendor-sub-tab {{ padding: 8px 16px; font-size: 0.8rem; font-weight: 600; border: 2px solid #e5e7eb; background: white; border-radius: 8px; cursor: pointer; transition: all 0.15s; }}
        .vendor-sub-tab:hover:not(.active) {{ background: #f9fafb; border-color: #d1d5db; }}
        .vendor-sub-tab.active {{ border-color: #f59e0b; background: #fffbeb; color: #92400e; }}
        .vendor-sub-tab .vtab-count {{ font-size: 0.7rem; background: #e5e7eb; padding: 1px 6px; border-radius: 9999px; margin-left: 4px; }}
        .vendor-sub-tab.active .vtab-count {{ background: #fde68a; }}
        .vendor-panel {{ display: none; }}
        .vendor-panel.active {{ display: block; }}
        .vendor-summary-card {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 20px; }}
        .vendor-stat {{ background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; text-align: center; }}
        .vendor-stat .stat-label {{ font-size: 0.7rem; font-weight: 600; text-transform: uppercase; color: #6b7280; margin-bottom: 4px; }}
        .vendor-stat .stat-value {{ font-size: 1.2rem; font-weight: 700; color: #1f2937; }}
        .invoice-placeholder {{ text-align: center; padding: 40px; background: #fefce8; border: 2px dashed #fbbf24; border-radius: 12px; color: #92400e; }}
        .match-badge {{ font-size: 0.7rem; font-weight: 600; padding: 2px 8px; border-radius: 9999px; }}
        .match-yes {{ background: #d1fae5; color: #065f46; }}
        .match-no {{ background: #fee2e2; color: #991b1b; }}
        /* Non-bulk click-to-link styles */
        .recon-selectable {{ cursor: pointer; transition: background 0.1s; }}
        .recon-selectable:hover {{ background: #eff6ff !important; }}
        .recon-selected {{ background: #dbeafe !important; border-left: 3px solid #2563eb; }}
        .recon-cc-clickable {{ cursor: pointer; transition: background 0.1s; }}
        .recon-cc-clickable:hover {{ background: #faf5ff !important; }}
        .recon-matched {{ background: #f0fdf4 !important; }}
        .recon-cc-matched {{ background: #fdf4ff !important; }}
        .recon-match-link {{ font-size: 0.7rem; font-weight: 600; padding: 2px 8px; border-radius: 9999px; display:inline-block; }}
        .recon-match-link-gastos {{ background: #e0e7ff; color: #3730a3; }}
        .recon-match-link-cc {{ background: #fce7f3; color: #9d174d; }}
        .recon-unmatch-btn {{ background:#fee2e2; color:#991b1b; border:none; padding:2px 8px; border-radius:6px; font-size:0.7rem; font-weight:600; cursor:pointer; margin-left:4px; }}
        /* Collapsible sections */
        .section-header {{ cursor: pointer; user-select: none; display: flex; align-items: center; gap: 8px; }}
        .section-header:hover {{ opacity: 0.85; }}
        .collapse-chevron {{ transition: transform 0.2s; font-size: 0.8rem; color: #9ca3af; }}
        .collapse-chevron.collapsed {{ transform: rotate(-90deg); }}
        .section-body {{ transition: max-height 0.3s ease, opacity 0.2s ease; overflow: hidden; }}
        .section-body.collapsed {{ max-height: 0 !important; opacity: 0; padding-top: 0; padding-bottom: 0; }}
        .match-pending {{ background: #f3f4f6; color: #6b7280; }}
        /* Click-to-link matching styles */
        .clickable-row {{ cursor: pointer; transition: all 0.15s; }}
        .clickable-row:hover {{ background-color: #eff6ff !important; }}
        .row-selected {{ background-color: #dbeafe !important; outline: 2px solid #3b82f6; outline-offset: -2px; }}
        .row-matched {{ background-color: #f0fdf4 !important; }}
        .row-matched-partner {{ background-color: #f0fdf4 !important; }}
        .match-color-1 {{ border-left: 4px solid #ef4444; }}
        .match-color-2 {{ border-left: 4px solid #f97316; }}
        .match-color-3 {{ border-left: 4px solid #eab308; }}
        .match-color-4 {{ border-left: 4px solid #22c55e; }}
        .match-color-5 {{ border-left: 4px solid #3b82f6; }}
        .match-color-6 {{ border-left: 4px solid #8b5cf6; }}
        .match-color-7 {{ border-left: 4px solid #ec4899; }}
        .match-color-8 {{ border-left: 4px solid #14b8a6; }}
        .match-color-9 {{ border-left: 4px solid #f43f5e; }}
        .match-color-0 {{ border-left: 4px solid #6366f1; }}
        .match-toolbar {{ display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; margin-bottom: 16px; font-size: 0.85rem; }}
        .match-toolbar .mode-label {{ font-weight: 700; color: #1e40af; }}
        .match-toolbar button {{ padding: 4px 12px; font-size: 0.8rem; font-weight: 600; border: 1px solid #93c5fd; background: white; border-radius: 6px; cursor: pointer; }}
        .match-toolbar button:hover {{ background: #dbeafe; }}
        .match-toolbar .cancel-btn {{ border-color: #fca5a5; color: #dc2626; }}
        .match-toolbar .cancel-btn:hover {{ background: #fee2e2; }}
        .unmatch-btn {{ padding: 2px 8px; font-size: 0.7rem; font-weight: 600; border: 1px solid #fca5a5; background: white; border-radius: 4px; cursor: pointer; color: #dc2626; }}
        .unmatch-btn:hover {{ background: #fee2e2; }}
        .review-cb {{ width: 16px; height: 16px; cursor: pointer; accent-color: #16a34a; }}
        .review-btn {{ padding: 4px 12px; font-size: 0.75rem; font-weight: 600; border: 1px solid #d1d5db; background: white; border-radius: 6px; cursor: pointer; transition: all 0.15s; }}
        .review-btn:hover {{ background: #f3f4f6; }}
        .review-btn.active {{ background: #16a34a; color: white; border-color: #16a34a; }}
        .reviewed-section {{ border: 2px dashed #86efac; background: #f0fdf4; }}
        .reviewed-section h2 {{ color: #15803d; }}
        th.cb-col {{ width: 40px; text-align: center; }}
        /* Progress bar */
        .progress-bar-outer {{ background: #e5e7eb; border-radius: 9999px; height: 24px; overflow: hidden; position: relative; }}
        .progress-bar-inner {{ height: 100%; border-radius: 9999px; transition: width 0.5s ease; background: linear-gradient(90deg, #10b981, #059669); }}
        .progress-bar-label {{ position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); font-size: 0.75rem; font-weight: 700; color: #1f2937; text-shadow: 0 0 3px rgba(255,255,255,0.8); }}
        /* Global search */
        .global-search-container {{ position: relative; }}
        .global-search-input {{ width: 100%; padding: 10px 14px 10px 36px; border: 2px solid #d1d5db; border-radius: 10px; font-size: 0.9rem; background: white; transition: border-color 0.2s; }}
        .global-search-input:focus {{ outline: none; border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,0.15); }}
        .global-search-icon {{ position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: #9ca3af; font-size: 0.9rem; }}
        .global-results {{ margin-top: 8px; background: white; border: 1px solid #e5e7eb; border-radius: 10px; max-height: 400px; overflow-y: auto; display: none; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }}
        .global-result-item {{ padding: 10px 14px; border-bottom: 1px solid #f3f4f6; cursor: pointer; display: flex; justify-content: space-between; align-items: center; }}
        .global-result-item:hover {{ background: #f9fafb; }}
        .global-result-section {{ font-size: 0.65rem; font-weight: 700; padding: 2px 8px; border-radius: 9999px; text-transform: uppercase; }}
        /* Aging highlight */
        .aging-warn {{ color: #f59e0b; font-weight: 600; }}
        .aging-danger {{ color: #dc2626; font-weight: 700; }}
        /* Duplicate flag */
        .dup-flag {{ background: #fef3c7; color: #92400e; font-size: 0.65rem; font-weight: 700; padding: 1px 6px; border-radius: 4px; margin-left: 4px; }}
        /* Note button */
        .note-btn {{ background: #f3f4f6; border: 1px solid #d1d5db; border-radius: 4px; padding: 2px 6px; cursor: pointer; font-size: 0.7rem; }}
        .note-btn:hover {{ background: #e5e7eb; }}
        .note-btn.has-note {{ background: #fef3c7; border-color: #fbbf24; }}
        /* Print styles */
        @media print {{
            .no-print {{ display: none !important; }}
            body {{ background: white; }}
            .card {{ box-shadow: none; border: 1px solid #e5e7eb; page-break-inside: avoid; }}
            .section-body.collapsed {{ max-height: none !important; opacity: 1 !important; }}
        }}
    </style>
</head>
<body class="bg-gray-50">
    <div class="max-w-7xl mx-auto px-4 py-8">
        <!-- Header -->
        <div class="mb-8">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px;">
                <div>
                    <h1 class="text-4xl font-bold text-gray-900 mb-2">La Rambla - Reconciliation Dashboard</h1>
                    <p class="text-lg text-gray-600">{MONTH_NAME} {PERIOD_YEAR} | Ponce, Puerto Rico</p>
                    <p class="text-sm text-gray-500 mt-2">Chick-fil-A Franchise - Monthly Expense Reconciliation</p>
                </div>
                <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                    {generate_month_selector()}
                    <button onclick="exportReconState()" class="recon-action-btn no-print" style="background:#2563eb;color:white;padding:8px 16px;border-radius:8px;border:none;font-size:0.85rem;font-weight:600;cursor:pointer;" title="Save all manual matches and reviewed items">Save State</button>
                    <button onclick="document.getElementById('importStateInput').click()" class="recon-action-btn no-print" style="background:#059669;color:white;padding:8px 16px;border-radius:8px;border:none;font-size:0.85rem;font-weight:600;cursor:pointer;" title="Load a previously saved reconciliation state">Load State</button>
                    <button onclick="printReconSummary()" class="no-print" style="background:#7c3aed;color:white;padding:8px 16px;border-radius:8px;border:none;font-size:0.85rem;font-weight:600;cursor:pointer;" title="Print reconciliation summary">Print</button>
                    <input type="file" id="importStateInput" accept=".json" style="display:none" onchange="importReconState(event)">
                </div>
            </div>
        </div>

        <!-- Summary Cards Row 1 -->
        <div class="grid grid-cols-2 md:grid-cols-5 gap-4 mb-4">
            <div class="card bg-white p-5">
                <h3 class="text-gray-500 text-xs font-semibold uppercase mb-1">Total Gastos</h3>
                <p class="text-2xl font-bold text-gray-900">${summary['total_expenses']:,.2f}</p>
                <p class="text-gray-400 text-xs mt-1">{summary['total_transactions']} transactions</p>
            </div>
            <div class="card bg-white p-5">
                <h3 class="text-green-600 text-xs font-semibold uppercase mb-1">Matched to CC</h3>
                <p class="text-2xl font-bold text-green-600">{summary['total_matched']}</p>
                <p class="text-gray-400 text-xs mt-1">${summary['matched_amount']:,.2f}</p>
            </div>
            <div class="card bg-white p-5">
                <h3 class="text-amber-600 text-xs font-semibold uppercase mb-1">Bulk Vendors</h3>
                <p class="text-2xl font-bold text-amber-600">{summary['unmatched_bulk']}</p>
                <p class="text-gray-400 text-xs mt-1">${summary['bulk_amount']:,.2f} (PORO GUSTO)</p>
            </div>
            <div class="card bg-white p-5">
                <h3 class="text-red-600 text-xs font-semibold uppercase mb-1">Other Unmatched</h3>
                <p class="text-2xl font-bold text-red-600">{summary['unmatched_other']}</p>
                <p class="text-gray-400 text-xs mt-1">${summary['other_unmatched_amount']:,.2f}</p>
            </div>
            <div class="card bg-white p-5">
                <h3 class="text-purple-600 text-xs font-semibold uppercase mb-1">CC No Receipt</h3>
                <p class="text-2xl font-bold text-purple-600">{summary['unmatched_cc']}</p>
                <p class="text-gray-400 text-xs mt-1">${summary['cc_unmatched_amount']:,.2f}</p>
            </div>
        </div>

        <!-- Reconciliation Progress Bar -->
        <div class="card bg-white p-5 mb-4">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                <h3 class="text-sm font-bold text-gray-700">Reconciliation Progress</h3>
                <div style="display:flex; gap:16px; font-size:0.8rem;">
                    <span id="reconProgressPct" style="font-weight:700;color:#059669;"></span>
                    <span id="reconVariance" style="font-weight:600;color:#6b7280;"></span>
                </div>
            </div>
            <div class="progress-bar-outer">
                <div class="progress-bar-inner" id="reconProgressBar" style="width:0%"></div>
                <span class="progress-bar-label" id="reconProgressLabel"></span>
            </div>
            <div style="display:flex; justify-content:space-between; margin-top:8px; font-size:0.75rem; color:#6b7280;">
                <span id="reconProgressDetail"></span>
                <span id="reconVarianceDetail"></span>
            </div>
        </div>

        <!-- Global Search -->
        <div class="card bg-white p-4 mb-4 no-print">
            <div class="global-search-container">
                <span class="global-search-icon">&#128269;</span>
                <input type="text" class="global-search-input" id="globalSearch" placeholder="Search across all sections — vendors, descriptions, amounts..." onkeyup="globalSearchHandler()" onfocus="globalSearchHandler()">
                <div class="global-results" id="globalResults"></div>
            </div>
        </div>

        <!-- Charts Row -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
            <div class="card bg-white p-6">
                <h2 class="text-lg font-bold text-gray-900 mb-4">Expense Categories</h2>
                <div class="chart-container"><canvas id="categoryChart"></canvas></div>
            </div>
            <div class="card bg-white p-6">
                <h2 class="text-lg font-bold text-gray-900 mb-4">Match Confidence &amp; Card Distribution</h2>
                <div class="chart-container"><canvas id="tierChart"></canvas></div>
            </div>
        </div>

        <!-- Card Summary -->
        <div class="card bg-white p-6 mb-8">
            <h2 class="text-lg font-bold text-gray-900 mb-4">Credit Card Summary</h2>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div class="border-l-4 border-blue-500 pl-4">
                    <h4 class="font-semibold text-gray-900">Chase Ink 4348</h4>
                    <p class="text-2xl font-bold text-gray-900">${card_summary['Chase Ink 4348']['total']:,.2f}</p>
                    <p class="text-sm text-gray-500">{card_summary['Chase Ink 4348']['count']} charges</p>
                </div>
                <div class="border-l-4 border-green-500 pl-4">
                    <h4 class="font-semibold text-gray-900">AMEX Platinum 62002</h4>
                    <p class="text-2xl font-bold text-gray-900">${card_summary['AMEX Platinum 62002']['total']:,.2f}</p>
                    <p class="text-sm text-gray-500">{card_summary['AMEX Platinum 62002']['count']} charges</p>
                </div>
                <div class="border-l-4 border-orange-500 pl-4">
                    <h4 class="font-semibold text-gray-900">AMEX Delta 71003</h4>
                    <p class="text-2xl font-bold text-gray-900">${card_summary['AMEX Delta 71003']['total']:,.2f}</p>
                    <p class="text-sm text-gray-500">{card_summary['AMEX Delta 71003']['count']} charges</p>
                </div>
            </div>
        </div>

        <!-- ======== MAIN TAB BAR ======== -->
        <div class="main-tab-bar">
            <button class="main-tab active" onclick="switchMainTab('recon')">Reconciliation <span class="tab-count">{len(matches) + len(unmatched_expenses_other) + len(unmatched_cc_charges)}</span></button>
            <button class="main-tab" onclick="switchMainTab('bulk')">Bulk Vendors <span class="tab-count">{len(unmatched_expenses_bulk)}</span></button>
        </div>

        <!-- ======== RECON TAB CONTENT ======== -->
        <div id="reconTab">

        <!-- ======== SECTION 1: MATCHED TRANSACTIONS ======== -->
        <div class="card bg-white p-6 mb-8">
            <div class="section-header" onclick="toggleSection('matched')">
                <span class="collapse-chevron" id="chevron_matched">▼</span>
                <h2 class="text-lg font-bold text-gray-900 mb-0">Matched Transactions <span class="section-count">{len(matches)}</span></h2>
            </div>
            <div class="section-body" id="body_matched">
            <p class="text-sm text-gray-500 mb-4 mt-1">Gastos expenses successfully matched to a credit card charge</p>
            <div class="filter-bar">
                <div><label>Search</label><br><input type="text" id="matchedSearch" placeholder="Vendor, category..." onkeyup="filterTable('matched')"></div>
                <div><label>Vendor</label><br><select id="matchedVendorFilter" onchange="filterTable('matched')"><option value="">All Vendors</option></select></div>
                <div><label>Source</label><br><select id="matchedSourceFilter" onchange="filterTable('matched')"><option value="">All Sources</option><option value="Chase">Chase Ink</option><option value="AMEX Platinum">AMEX Platinum</option><option value="AMEX Delta">AMEX Delta</option><option value="Banco Popular">Banco Popular</option></select></div>
                <div><label>Tier</label><br><select id="matchedTierFilter" onchange="filterTable('matched')"><option value="">All Tiers</option><option value="1">Tier 1 (Exact)</option><option value="2">Tier 2 (Strong)</option><option value="3">Tier 3 (Probable)</option><option value="4">Tier 4 (Weak)</option></select></div>
                <div style="margin-left:auto;align-self:end;"><span id="matchedCount" class="text-sm text-gray-500"></span></div>
            </div>
            <div class="overflow-x-auto">
                <table id="matchedTableContainer">
                    <thead><tr>
                        <th class="sortable" data-table="matched" data-col="0">Date</th>
                        <th class="sortable" data-table="matched" data-col="1">Vendor</th>
                        <th class="sortable" data-table="matched" data-col="2">Category</th>
                        <th class="sortable" data-table="matched" data-col="3" style="text-align:right">Expense $</th>
                        <th class="sortable" data-table="matched" data-col="4" style="text-align:right">CC $</th>
                        <th class="sortable" data-table="matched" data-col="5">Source</th>
                        <th class="sortable" data-table="matched" data-col="6" style="text-align:center">Tier</th>
                        <th style="text-align:center;width:50px;">Note</th>
                    </tr></thead>
                    <tbody id="matchedTable"></tbody>
                </table>
            </div>
            </div><!-- end section-body matched -->
        </div>

        <!-- ======== MANUAL MATCH TOOLBAR (Non-Bulk) ======== -->
        <div class="card bg-white p-4 mb-4" id="recon_match_toolbar" style="border-left: 4px solid #2563eb;">
            <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
                <div style="flex:1; min-width:200px;">
                    <span style="font-weight:700; color:#1e40af; font-size:0.9rem;">Manual Match</span>
                    <button id="reconModeToggle" onclick="toggleReconMode()" style="padding:4px 12px; background:#e0e7ff; color:#3730a3; border:1px solid #a5b4fc; border-radius:6px; font-size:0.78rem; font-weight:600; cursor:pointer; margin-left:8px;">Mode: GASTOS → CC</button>
                    <span id="reconMatchLabel" style="font-size:0.85rem; color:#4b5563; margin-left:8px;">Click GASTOS rows to select, then click a CC charge to link</span>
                </div>
                <div id="reconMatchStats" style="font-size:0.85rem; font-weight:600; color:#059669; display:none;"></div>
                <button id="reconCancelBtn" onclick="cancelReconSelection()" style="display:none; padding:6px 14px; background:#ef4444; color:white; border:none; border-radius:6px; font-size:0.8rem; font-weight:600; cursor:pointer;">Cancel</button>
                <span id="reconMatchedCount" style="font-size:0.85rem; font-weight:600; color:#059669;"></span>
            </div>
        </div>

        <!-- ======== SECTION 3: UNMATCHED GASTOS (Other) ======== -->
        <div class="card bg-white p-6 mb-8">
            <div class="section-header" onclick="toggleSection('other')">
                <span class="collapse-chevron" id="chevron_other">▼</span>
                <h2 class="text-lg font-bold text-red-700 mb-0">Unmatched Gastos (No CC/Bank Match) <span class="section-count" id="otherSectionCount">{len(unmatched_expenses_other)}</span></h2>
            </div>
            <div class="section-body" id="body_other">
            <p class="text-sm text-gray-500 mb-4 mt-1">Expenses in the GASTOS system with no matching credit card or bank charge found. Click rows to select, then click a CC charge below to link. Total: <strong>${summary['other_unmatched_amount']:,.2f}</strong></p>
            <div class="filter-bar">
                <div><label>Search</label><br><input type="text" id="otherSearch" placeholder="Vendor, category..." onkeyup="filterTable('other')"></div>
                <div><label>Vendor</label><br><select id="otherVendorFilter" onchange="filterTable('other')"><option value="">All Vendors</option></select></div>
                <div><label>Category</label><br><select id="otherCatFilter" onchange="filterTable('other')"><option value="">All Categories</option></select></div>
                <div style="margin-left:auto;align-self:end;"><span id="otherCount" class="text-sm text-gray-500"></span></div>
            </div>
            <div class="overflow-x-auto">
                <table id="otherTableContainer">
                    <thead><tr>
                        <th class="cb-col">Rev</th>
                        <th>Date</th>
                        <th>Vendor</th>
                        <th>Category</th>
                        <th style="text-align:right">Amount</th>
                        <th>Invoice</th>
                        <th style="text-align:center;width:40px;">Age</th>
                        <th style="text-align:center">Match</th>
                    </tr></thead>
                    <tbody id="otherTable"></tbody>
                </table>
            </div>
            </div><!-- end section-body other -->
        </div>

        <!-- ======== SECTION 4: CC/BANK CHARGES WITHOUT RECEIPT ======== -->
        <div class="card bg-white p-6 mb-8">
            <div class="section-header" onclick="toggleSection('cc')">
                <span class="collapse-chevron" id="chevron_cc">▼</span>
                <h2 class="text-lg font-bold text-purple-700 mb-0">CC Charges Missing from Gastos <span class="section-count" id="ccSectionCount">{len(unmatched_cc_charges)}</span></h2>
            </div>
            <div class="section-body" id="body_cc">
            <p class="text-sm text-gray-500 mb-4 mt-1">Charges on credit card statements that have no matching expense receipt. Click to link with selected GASTOS rows above. Total: <strong>${summary['cc_unmatched_amount']:,.2f}</strong></p>
            <div class="filter-bar">
                <div><label>Search</label><br><input type="text" id="ccSearch" placeholder="Description..." onkeyup="filterTable('cc')"></div>
                <div><label>Source</label><br><select id="ccSourceFilter" onchange="filterTable('cc')"><option value="">All Sources</option><option value="Chase">Chase Ink</option><option value="AMEX Platinum">AMEX Platinum</option><option value="AMEX Delta">AMEX Delta</option><option value="Banco Popular">Banco Popular</option></select></div>
                <div style="margin-left:auto;align-self:end;"><span id="ccCount" class="text-sm text-gray-500"></span></div>
            </div>
            <div class="overflow-x-auto">
                <table id="ccTableContainer">
                    <thead><tr>
                        <th class="cb-col">Rev</th>
                        <th>Date</th>
                        <th>Description</th>
                        <th style="text-align:right">Amount</th>
                        <th>Card</th>
                        <th>Category</th>
                        <th style="text-align:center;width:40px;">Age</th>
                        <th style="text-align:center">Match</th>
                    </tr></thead>
                    <tbody id="ccTable"></tbody>
                </table>
            </div>
            </div><!-- end section-body cc -->
        </div>

        <!-- ======== CROSS-MONTH TRANSFERS ======== -->
        <div class="card bg-white p-6 mb-8" style="border-left:4px solid #f59e0b;">
            <div class="section-header" onclick="toggleSection('movedIn')">
                <span class="collapse-chevron" id="chevron_movedIn">▼</span>
                <h2 class="text-lg font-bold text-amber-700 mb-0">Incoming from Other Months <span class="section-count" id="movedInBadge">0</span></h2>
            </div>
            <div class="section-body" id="body_movedIn">
            <p class="text-sm text-gray-500 mb-4 mt-1">Items moved to this month from other reconciliation periods.</p>
            <div class="overflow-x-auto">
                <table>
                    <thead><tr>
                        <th class="cb-col">Undo</th>
                        <th>Date</th>
                        <th>Vendor / Description</th>
                        <th style="text-align:right">Amount</th>
                        <th>Type</th>
                        <th>From</th>
                    </tr></thead>
                    <tbody id="movedInTable"></tbody>
                </table>
            </div>
            <p id="movedInEmpty" class="text-sm text-gray-400 text-center py-4">No items received from other months.</p>
            </div>
        </div>

        <div class="card bg-white p-6 mb-8" style="border-left:4px solid #6366f1;">
            <div class="section-header" onclick="toggleSection('movedOut')">
                <span class="collapse-chevron" id="chevron_movedOut">▼</span>
                <h2 class="text-lg font-bold text-indigo-700 mb-0">Moved to Other Months <span class="section-count" id="movedOutBadge">0</span></h2>
            </div>
            <div class="section-body" id="body_movedOut">
            <p class="text-sm text-gray-500 mb-4 mt-1">Items from this month that have been moved to a different reconciliation period.</p>
            <div class="overflow-x-auto">
                <table>
                    <thead><tr>
                        <th class="cb-col">Undo</th>
                        <th>Date</th>
                        <th>Vendor / Description</th>
                        <th style="text-align:right">Amount</th>
                        <th>Type</th>
                        <th>Destination</th>
                    </tr></thead>
                    <tbody id="movedOutTable"></tbody>
                </table>
            </div>
            <p id="movedOutEmpty" class="text-sm text-gray-400 text-center py-4">No items moved to other months.</p>
            </div>
        </div>

        <!-- ======== SECTION 5: REVIEWED - NO GASTOS MATCH EXPECTED ======== -->
        <div class="card reviewed-section p-6 mb-8">
            <div class="section-header" onclick="toggleSection('reviewed')">
                <span class="collapse-chevron" id="chevron_reviewed">▼</span>
                <h2 class="text-lg font-bold mb-0">Reviewed - No GASTOS Match Expected <span class="section-count" id="reviewedBadge">0</span></h2>
            </div>
            <div class="section-body" id="body_reviewed">
            <p class="text-sm text-gray-500 mb-4 mt-1">Items you've checked off as reviewed. These charges are not expected to have a GASTOS match. <button class="review-btn" onclick="event.stopPropagation(); clearAllReviewed()">Uncheck All</button></p>
            <div class="overflow-x-auto">
                <table id="reviewedTableContainer">
                    <thead><tr>
                        <th class="cb-col">Undo</th>
                        <th>Date</th>
                        <th>Vendor / Description</th>
                        <th>Category</th>
                        <th style="text-align:right">Amount</th>
                        <th>Source</th>
                    </tr></thead>
                    <tbody id="reviewedTable"></tbody>
                </table>
            </div>
            <p id="reviewedEmpty" class="text-sm text-gray-400 text-center py-4">No reviewed items yet. Check the box next to any unmatched charge to move it here.</p>
            </div>
        </div>

        </div><!-- end reconTab -->

        <!-- ======== BULK VENDORS TAB CONTENT ======== -->
        <div id="bulkTab" style="display:none;">
            <div class="card bg-white p-6 mb-8">
                <h2 class="text-lg font-bold text-amber-700 mb-1">Bulk Vendor Reconciliation <span class="section-count">{len(unmatched_expenses_bulk)}</span></h2>
                <p class="text-sm text-gray-500 mb-4">Coca Cola, Freshpoint, Holsum, PR Coffee Roasters, and Tres Monjitas — paid via aggregate PORO GUSTO vendor payment. Total: <strong>${summary['bulk_amount']:,.2f}</strong>. Select a vendor to view transactions and match against invoices.</p>

                <!-- Vendor sub-tabs -->
                <div class="vendor-sub-tabs" id="vendorSubTabs">
                    <button class="vendor-sub-tab active" onclick="switchVendorTab('COCA COLA PUERTO RICO')"><span class="vendor-tag vendor-coca" style="font-size:0.8rem">Coca Cola</span> <span class="vtab-count">{bulk_vendor_summary['COCA COLA PUERTO RICO']['count']}</span></button>
                    <button class="vendor-sub-tab" onclick="switchVendorTab('FRESHPOINT')"><span class="vendor-tag vendor-fresh" style="font-size:0.8rem">Freshpoint</span> <span class="vtab-count">{bulk_vendor_summary['FRESHPOINT']['count']}</span></button>
                    <button class="vendor-sub-tab" onclick="switchVendorTab('HOLSUM DE PUERTO RICO')"><span class="vendor-tag vendor-holsum" style="font-size:0.8rem">Holsum</span> <span class="vtab-count">{bulk_vendor_summary['HOLSUM DE PUERTO RICO']['count']}</span></button>
                    <button class="vendor-sub-tab" onclick="switchVendorTab('PR COFFEE ROASTERS')"><span class="vendor-tag vendor-coffee" style="font-size:0.8rem">PR Coffee</span> <span class="vtab-count">{bulk_vendor_summary['PR COFFEE ROASTERS']['count']}</span></button>
                    <button class="vendor-sub-tab" onclick="switchVendorTab('TRES MONJITAS')"><span class="vendor-tag vendor-monjitas" style="font-size:0.8rem">Tres Monjitas</span> <span class="vtab-count">{bulk_vendor_summary['TRES MONJITAS']['count']}</span></button>
                </div>

                <!-- Per-vendor panels (one per vendor) -->
                <div id="vendorPanelsContainer">
""" + "".join([f"""
                    <div class="vendor-panel {'active' if v == 'COCA COLA PUERTO RICO' else ''}" id="panel_{v.replace(' ', '_')}">
                        <!-- Match toolbar -->
                        <div class="match-toolbar" id="matchToolbar_{v.replace(' ', '_')}">
                            <span class="mode-label" id="matchModeLabel_{v.replace(' ', '_')}">Click a GASTOS row, then click an invoice row to link them</span>
                            <button onclick="cancelSelection('{v.replace(' ', '_')}')" class="cancel-btn" id="cancelBtn_{v.replace(' ', '_')}" style="display:none">Cancel</button>
                            <span style="margin-left:auto; font-size:0.8rem; color:#6b7280;" id="matchStats_{v.replace(' ', '_')}"></span>
                        </div>

                        <!-- Vendor summary stats -->
                        <div class="vendor-summary-card">
                            <div class="vendor-stat">
                                <div class="stat-label">GASTOS Entries</div>
                                <div class="stat-value" id="statGastos_{v.replace(' ', '_')}">{bulk_vendor_summary[v]['count']}</div>
                            </div>
                            <div class="vendor-stat">
                                <div class="stat-label">GASTOS Total</div>
                                <div class="stat-value">${bulk_vendor_summary[v]['total']:,.2f}</div>
                            </div>
                            <div class="vendor-stat">
                                <div class="stat-label">Invoices Loaded</div>
                                <div class="stat-value" id="statInvoices_{v.replace(' ', '_')}">{bulk_vendor_summary[v]['invoice_count']}</div>
                            </div>
                            <div class="vendor-stat">
                                <div class="stat-label">Matched</div>
                                <div class="stat-value" id="statMatched_{v.replace(' ', '_')}" style="color: {'#16a34a' if bulk_vendor_summary[v]['matched'] > 0 else '#9ca3af'}">0 / {bulk_vendor_summary[v]['count']}</div>
                            </div>
                        </div>

                        <!-- Side-by-side tables for GASTOS and Invoices -->
                        <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 16px;">
                            <!-- Left: GASTOS Expenses -->
                            <div>
                                <h3 class="text-md font-bold text-gray-800 mb-2">GASTOS Expenses</h3>
                                <div class="overflow-x-auto">
                                    <table>
                                        <thead><tr>
                                            <th>Date</th>
                                            <th style="text-align:right">Amount</th>
                                            <th>Invoice #</th>
                                            <th style="text-align:center">Match</th>
                                        </tr></thead>
                                        <tbody id="vendorGastos_{v.replace(' ', '_')}"></tbody>
                                    </table>
                                </div>
                            </div>
                            <!-- Right: Vendor Invoices -->
                            <div>
                                <h3 class="text-md font-bold text-gray-800 mb-2">Vendor Invoices</h3>
                                <div id="vendorInvoiceSection_{v.replace(' ', '_')}">
                                    <div class="invoice-placeholder" id="invoicePlaceholder_{v.replace(' ', '_')}">
                                        <p class="text-lg font-bold mb-2">No invoices loaded yet</p>
                                        <p class="text-sm">Upload a CSV or PDF file for this vendor to the uploads folder.</p>
                                        <p class="text-xs mt-2 text-amber-700">Accepted names: invoice_*.csv, invoice_*.xlsx, or invoice_*.pdf</p>
                                    </div>
                                    <div class="overflow-x-auto" id="invoiceTableWrap_{v.replace(' ', '_')}" style="display:none;">
                                        <table>
                                            <thead><tr>
                                                <th>Date</th>
                                                <th style="text-align:right">Amount</th>
                                                <th>Invoice #</th>
                                                <th style="text-align:center">Match</th>
                                            </tr></thead>
                                            <tbody id="vendorInvoice_{v.replace(' ', '_')}"></tbody>
                                        </table>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- CC/Bank Charges for this vendor -->
                        <div id="vendorCCSection_{v.replace(' ', '_')}" style="margin-top: 16px; {'display:none' if len(cc_by_vendor[v]) == 0 else ''}">
                            <h3 class="text-md font-bold text-purple-700 mb-2">CC/Bank Charges <span class="section-count">{len(cc_by_vendor[v])}</span></h3>
                            <p class="text-xs text-gray-500 mb-2">Credit card and bank charges related to this vendor (from statements, not in GASTOS). Click to link to a GASTOS row.</p>
                            <div class="overflow-x-auto">
                                <table>
                                    <thead><tr>
                                        <th>Date</th>
                                        <th>Description</th>
                                        <th style="text-align:right">Amount</th>
                                        <th>Source</th>
                                        <th style="text-align:center">Match</th>
                                    </tr></thead>
                                    <tbody id="vendorCC_{v.replace(' ', '_')}"></tbody>
                                </table>
                            </div>
                        </div>
                    </div>
""" for v in BULK_VENDORS]) + f"""
                </div>
            </div>
        </div><!-- end bulkTab -->

        <!-- Notes -->
        <div class="card bg-blue-50 border-l-4 border-blue-500 p-6 mb-8">
            <h3 class="text-lg font-bold text-blue-900 mb-2">Reconciliation Notes</h3>
            <p class="text-sm text-blue-800 mb-2"><strong>Match Tiers:</strong> Tier 1 = Exact match (amount + vendor within 3 days), Tier 2 = Strong (5 days), Tier 3 = Probable (7 days), Tier 4 = Weak (amount tolerance ±$2 or similar vendor with exact amount/date)</p>
            <p class="text-sm text-blue-800 mb-2"><strong>Bulk Vendors:</strong> Coca Cola, Freshpoint, Holsum, PR Coffee, and Tres Monjitas are paid via the PORO GUSTO aggregate vendor payment system visible on the bank statement, not individual CC charges.</p>
            <p class="text-sm text-blue-800 mb-2"><strong>Bank EFT Payments:</strong> EFT debits (Delta Dental, Triple-S, Dept de Hacienda, Mutual of Omaha, etc.) appear in the CC Charges Missing section as Banco Popular source for manual matching.</p>
            <p class="text-sm text-blue-800 mb-2"><strong>ACH/Bank Transfers:</strong> TRANF ATHM employee payments and TELEPAGO transfers appear in CC Charges Missing as Banco Popular source.</p>
            <p class="text-sm text-blue-800 mb-2"><strong>Excluded Bank Transactions:</strong> CC bill payments (Chase/AMEX), PORO GUSTO vendor aggregate, BPPR merchant fees, and AMEX discount fees are excluded from matching (they are meta-transactions).</p>
            <p class="text-sm text-blue-800"><strong>CC Charges Without Receipt:</strong> Some CC charges are personal/travel expenses (hotels, restaurants) or items not yet entered in GASTOS (SYSCO orders, Costco, etc.).</p>
        </div>

        <!-- Footer -->
        <div class="text-center text-gray-500 text-sm py-8 border-t border-gray-200">
            <p>Generated {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} | La Rambla | {MONTH_NAME} {PERIOD_YEAR} Reconciliation</p>
        </div>
    </div>

    <script>
        // ===== DATA EMBEDDED AS JSON =====
        const matchedData = {json.dumps(matches)};
        const bulkData = {json.dumps(unmatched_expenses_bulk)};
        const bulkByVendor = {json.dumps(bulk_by_vendor)};
        const invoiceData = {json.dumps({k: v for k, v in invoice_data.items()})};
        const bulkInvoiceMatches = {json.dumps(bulk_invoice_matches)};
        const ccByVendor = {json.dumps(cc_by_vendor)};
        const otherData = {json.dumps(unmatched_expenses_other)};
        const ccData = {json.dumps(cc_non_bulk)};
        const categoryBreakdown = {json.dumps(category_breakdown)};
        const tierCounts = {json.dumps(tier_counts)};
        const tierAmounts = {json.dumps(tier_amounts)};

        // ===== UTILITIES =====
        function escapeHtml(text) {{
            if (!text) return '';
            const map = {{'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'}};
            return text.replace(/[&<>"']/g, m => map[m]);
        }}

        function fmtMoney(v) {{ return '$' + parseFloat(v).toLocaleString('en-US', {{minimumFractionDigits:2, maximumFractionDigits:2}}); }}

        // Vendor tag color mapping
        const vendorColors = {{
            'COCA COLA PUERTO RICO': 'vendor-coca',
            'FRESHPOINT': 'vendor-fresh',
            'HOLSUM DE PUERTO RICO': 'vendor-holsum',
            'PR COFFEE ROASTERS': 'vendor-coffee',
            'TRES MONJITAS': 'vendor-monjitas',
        }};
        function vendorTag(v) {{
            const cls = vendorColors[v] || 'bg-gray-100 text-gray-800';
            return `<span class="vendor-tag ${{cls}}">${{escapeHtml(v)}}</span>`;
        }}

        // Source badge
        function sourceBadge(s) {{
            let cls = 'source-chase';
            if (s && s.includes('Platinum')) cls = 'source-amex-plat';
            else if (s && s.includes('Delta')) cls = 'source-amex-delta';
            return `<span class="vendor-tag ${{cls}}">${{escapeHtml(s)}}</span>`;
        }}

        // ===== POPULATE TABLES =====
        function populateMatchedTable(data) {{
            const tbody = document.getElementById('matchedTable');
            tbody.innerHTML = '';
            // Auto-matched rows
            const notes = getReconNotes();
            data.forEach((row, ri) => {{
                const noteKey = 'auto_' + ri;
                const hasNote = notes[noteKey] ? true : false;
                const noteTitle = hasNote ? escapeHtml(notes[noteKey]) : 'Add note';
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>${{row.exp_date}}</td>
                    <td><strong>${{escapeHtml(row.exp_vendor)}}</strong><br><small class="text-gray-500">${{escapeHtml((row.match_desc||'').substring(0, 50))}}</small></td>
                    <td>${{escapeHtml(row.exp_category)}}</td>
                    <td style="text-align:right"><strong>${{fmtMoney(row.exp_amount)}}</strong></td>
                    <td style="text-align:right">${{fmtMoney(row.match_amount)}}</td>
                    <td>${{sourceBadge(row.match_source)}}</td>
                    <td style="text-align:center"><span class="tier-badge tier-${{row.tier}}">Tier ${{row.tier}}</span></td>
                    <td style="text-align:center"><button class="note-btn ${{hasNote ? 'has-note' : ''}}" onclick="editNote('auto', ${{ri}})" title="${{noteTitle}}">${{hasNote ? '&#128221;' : '&#128196;'}}</button></td>
                `;
                tbody.appendChild(tr);
            }});
            // Manual match rows from non-bulk click-to-link
            const reconMatches = getReconMatches();
            let manualCount = 0;
            reconMatches.forEach((m, mi) => {{
                // Apply filters if active
                const search = document.getElementById('matchedSearch') ? document.getElementById('matchedSearch').value.toLowerCase() : '';
                const vendorFilter = document.getElementById('matchedVendorFilter') ? document.getElementById('matchedVendorFilter').value : '';
                const srcFilter = document.getElementById('matchedSourceFilter') ? document.getElementById('matchedSourceFilter').value : '';
                const tierFilter = document.getElementById('matchedTierFilter') ? document.getElementById('matchedTierFilter').value : '';
                const vendorStr = (m.gastos_vendors || []).join(', ');
                // Support both single-CC and multi-CC matches
                const isMultiCC = m.cc_indices && m.cc_indices.length > 0;
                const descStr = isMultiCC
                    ? (m.cc_descriptions || []).map(d => d.substring(0, 30)).join('; ')
                    : (m.cc_description || '');
                const ccAmt = isMultiCC ? (m.cc_total || 0) : (m.cc_amount || 0);
                const ccSrcStr = isMultiCC
                    ? [...new Set(m.cc_sources || [])].join(', ')
                    : (m.cc_source || '');
                if (search && !vendorStr.toLowerCase().includes(search) && !descStr.toLowerCase().includes(search)) return;
                if (vendorFilter && !vendorStr.includes(vendorFilter)) return;
                if (srcFilter && !ccSrcStr.includes(srcFilter)) return;
                if (tierFilter && tierFilter !== 'M') return;  // Manual tier is 'M'
                const diffStr = m.diff !== 0 ? ` <span style="color:#dc2626;font-size:0.75rem;">(diff: ${{fmtMoney(m.diff)}})</span>` : '';
                const ccSrcBadges = isMultiCC
                    ? [...new Set(m.cc_sources || [])].map(s => sourceBadge(s)).join(' ')
                    : sourceBadge(ccSrcStr);
                const manualNoteKey = 'manual_' + mi;
                const manualHasNote = notes[manualNoteKey] ? true : false;
                const manualNoteTitle = manualHasNote ? escapeHtml(notes[manualNoteKey]) : 'Add note';
                const tr = document.createElement('tr');
                tr.style.background = '#f0fdf4';
                tr.innerHTML = `
                    <td>${{(m.gastos_indices || []).map(gi => otherData[gi] ? otherData[gi].date : '?').join(', ')}}</td>
                    <td><strong>${{escapeHtml(vendorStr)}}</strong><br><small class="text-gray-500">${{escapeHtml(descStr.substring(0, 60))}}</small></td>
                    <td>${{(m.gastos_indices || []).map(gi => otherData[gi] ? escapeHtml(otherData[gi].category) : '').filter(Boolean).join(', ')}}</td>
                    <td style="text-align:right"><strong>${{fmtMoney(m.gastos_total)}}</strong></td>
                    <td style="text-align:right">${{fmtMoney(ccAmt)}}${{diffStr}}${{isMultiCC ? '<br><small style="color:#6b7280;">' + m.cc_indices.length + ' CC charges</small>' : ''}}</td>
                    <td>${{ccSrcBadges}}</td>
                    <td style="text-align:center"><span class="tier-badge" style="background:#d1fae5;color:#065f46;">Manual</span> <button onclick="undoReconFromMatched(${{mi}})" style="background:#fee2e2;color:#dc2626;border:none;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:0.75rem;margin-left:4px;" title="Undo this manual match">Undo</button></td>
                    <td style="text-align:center"><button class="note-btn ${{manualHasNote ? 'has-note' : ''}}" onclick="editNote('manual', ${{mi}})" title="${{manualNoteTitle}}">${{manualHasNote ? '&#128221;' : '&#128196;'}}</button></td>
                `;
                tbody.appendChild(tr);
                manualCount++;
            }});
            const totalShown = data.length + manualCount;
            const totalAll = matchedData.length + reconMatches.length;
            document.getElementById('matchedCount').textContent = totalShown + ' of ' + totalAll + ' shown';
            updateReconProgress();
        }}

        function undoReconFromMatched(matchIdx) {{
            unmatchReconGroup(matchIdx);
            filterTable('matched');
        }}

        // populateBulkTable - now handled by per-vendor panels in Bulk Vendors tab

        // ===== NON-BULK MANUAL MATCHING STATE =====
        const RECON_MATCH_KEY = 'cfa_recon_{PERIOD_KEY}_other_matches';
        let reconSelectedGastos = [];  // array of {{ idx, row }}
        let reconSelectedCC = [];      // array of {{ idx, row }} (for CC→GASTOS mode)
        let reconMode = 'gastos_to_cc';  // 'gastos_to_cc' or 'cc_to_gastos'

        function getReconMatches() {{
            try {{ return JSON.parse(localStorage.getItem(RECON_MATCH_KEY) || '[]'); }}
            catch(e) {{ return []; }}
        }}
        function saveReconMatches(matches) {{
            localStorage.setItem(RECON_MATCH_KEY, JSON.stringify(matches));
        }}

        // Build lookup: which other_idx → match group, which cc_idx → match group
        function buildReconMatchLookup() {{
            const matches = getReconMatches();
            const otherToMatch = {{}};  // other_idx → {{ matchIdx, color }}
            const ccToMatch = {{}};     // cc_idx → {{ matchIdx, color }}
            const matchColors = ['#dbeafe', '#fce7f3', '#d1fae5', '#fef3c7', '#e0e7ff', '#fce4ec', '#e8f5e9', '#fff3e0', '#f3e5f5', '#e0f7fa'];
            matches.forEach((m, mi) => {{
                const color = matchColors[mi % matchColors.length];
                (m.gastos_indices || []).forEach(gi => {{ otherToMatch[gi] = {{ matchIdx: mi, color }}; }});
                // Support both single cc_idx and multi cc_indices
                const ccIdxArr = m.cc_indices || (m.cc_idx !== undefined ? [m.cc_idx] : []);
                ccIdxArr.forEach(ci => {{ ccToMatch[ci] = {{ matchIdx: mi, color }}; }});
            }});
            return {{ otherToMatch, ccToMatch, matches }};
        }}

        function toggleReconMode() {{
            cancelReconSelection();
            reconMode = reconMode === 'gastos_to_cc' ? 'cc_to_gastos' : 'gastos_to_cc';
            const btn = document.getElementById('reconModeToggle');
            if (reconMode === 'gastos_to_cc') {{
                btn.textContent = 'Mode: GASTOS → CC';
                btn.style.background = '#e0e7ff';
                btn.style.color = '#3730a3';
                btn.style.borderColor = '#a5b4fc';
            }} else {{
                btn.textContent = 'Mode: CC → GASTOS';
                btn.style.background = '#fce7f3';
                btn.style.color = '#9d174d';
                btn.style.borderColor = '#f9a8d4';
            }}
            updateReconToolbar();
            filterTable('other');
            filterTable('cc');
        }}

        function selectReconGastos(idx, row) {{
            if (reconMode === 'cc_to_gastos') {{
                // In CC→GASTOS mode, clicking a GASTOS row completes the link
                if (reconSelectedCC.length === 0) {{
                    showToast('Select CC charges first, then click a GASTOS expense to link', 'error');
                    return;
                }}
                const matches = getReconMatches();
                const ccTotal = reconSelectedCC.reduce((s, c) => s + c.row.amount, 0);
                matches.push({{
                    gastos_indices: [idx],
                    gastos_amounts: [row.amount],
                    gastos_vendors: [row.vendor],
                    gastos_total: row.amount,
                    cc_indices: reconSelectedCC.map(c => c.idx),
                    cc_amounts: reconSelectedCC.map(c => c.row.amount),
                    cc_descriptions: reconSelectedCC.map(c => c.row.description),
                    cc_sources: reconSelectedCC.map(c => c.row.source),
                    cc_total: ccTotal,
                    diff: Math.round((row.amount - ccTotal) * 100) / 100,
                    timestamp: new Date().toISOString()
                }});
                saveReconMatches(matches);
                reconSelectedCC = [];
                updateReconToolbar();
                filterTable('matched');
                filterTable('other');
                filterTable('cc');
                showToast('Match linked successfully!');
                return;
            }}
            // GASTOS→CC mode: toggle GASTOS selection
            const existingIdx = reconSelectedGastos.findIndex(s => s.idx === idx);
            if (existingIdx >= 0) {{
                reconSelectedGastos.splice(existingIdx, 1);
            }} else {{
                reconSelectedGastos.push({{ idx, row }});
            }}
            updateReconToolbar();
            filterTable('other');
            filterTable('cc');
        }}

        function selectReconCC(ccIdx, ccRow) {{
            if (reconMode === 'cc_to_gastos') {{
                // Toggle CC selection
                const existingIdx = reconSelectedCC.findIndex(s => s.idx === ccIdx);
                if (existingIdx >= 0) {{
                    reconSelectedCC.splice(existingIdx, 1);
                }} else {{
                    reconSelectedCC.push({{ idx: ccIdx, row: ccRow }});
                }}
                updateReconToolbar();
                filterTable('other');
                filterTable('cc');
                return;
            }}
            // GASTOS→CC mode: clicking CC completes the link
            if (reconSelectedGastos.length === 0) {{
                showToast('Select GASTOS rows first, then click a CC charge to link', 'error');
                return;
            }}
            const matches = getReconMatches();
            const gastosTotal = reconSelectedGastos.reduce((s, g) => s + g.row.amount, 0);
            matches.push({{
                gastos_indices: reconSelectedGastos.map(g => g.idx),
                gastos_amounts: reconSelectedGastos.map(g => g.row.amount),
                gastos_vendors: reconSelectedGastos.map(g => g.row.vendor),
                gastos_total: gastosTotal,
                cc_idx: ccIdx,
                cc_amount: ccRow.amount,
                cc_description: ccRow.description,
                cc_source: ccRow.source,
                diff: Math.round((gastosTotal - ccRow.amount) * 100) / 100,
                timestamp: new Date().toISOString()
            }});
            saveReconMatches(matches);
            reconSelectedGastos = [];
            updateReconToolbar();
            filterTable('matched');
            filterTable('other');
            filterTable('cc');
            showToast('Match linked successfully!');
        }}

        function unmatchReconGroup(matchIdx) {{
            const matches = getReconMatches();
            matches.splice(matchIdx, 1);
            saveReconMatches(matches);
            filterTable('matched');
            filterTable('other');
            filterTable('cc');
        }}

        function cancelReconSelection() {{
            reconSelectedGastos = [];
            reconSelectedCC = [];
            updateReconToolbar();
            filterTable('other');
            filterTable('cc');
        }}

        function updateReconToolbar() {{
            const label = document.getElementById('reconMatchLabel');
            const stats = document.getElementById('reconMatchStats');
            const cancelBtn = document.getElementById('reconCancelBtn');
            const countLabel = document.getElementById('reconMatchedCount');
            const lookup = buildReconMatchLookup();
            const totalMatched = lookup.matches.reduce((s, m) => s + (m.gastos_indices || []).length, 0);

            if (reconMode === 'gastos_to_cc') {{
                if (reconSelectedGastos.length === 0) {{
                    label.textContent = 'Click GASTOS rows to select, then click a CC charge to link';
                    stats.style.display = 'none';
                    cancelBtn.style.display = 'none';
                }} else {{
                    const total = reconSelectedGastos.reduce((s, g) => s + g.row.amount, 0);
                    label.textContent = `${{reconSelectedGastos.length}} GASTOS selected`;
                    stats.textContent = `Total: ${{fmtMoney(total)}} — now click a CC charge to link`;
                    stats.style.display = 'inline';
                    cancelBtn.style.display = 'inline-block';
                }}
            }} else {{
                if (reconSelectedCC.length === 0) {{
                    label.textContent = 'Click CC charges to select, then click a GASTOS expense to link';
                    stats.style.display = 'none';
                    cancelBtn.style.display = 'none';
                }} else {{
                    const total = reconSelectedCC.reduce((s, c) => s + c.row.amount, 0);
                    label.textContent = `${{reconSelectedCC.length}} CC charges selected`;
                    stats.textContent = `Total: ${{fmtMoney(total)}} — now click a GASTOS expense to link`;
                    stats.style.display = 'inline';
                    cancelBtn.style.display = 'inline-block';
                }}
            }}
            countLabel.textContent = totalMatched > 0 ? `${{totalMatched}} items manually matched (${{lookup.matches.length}} groups)` : '';
        }}

        // ===== MOVE TO MONTH (Cross-Month Transfers) =====
        const MOVED_KEY = 'cfa_recon_{PERIOD_KEY}_moved';
        const MONTH_OPTIONS = {MONTH_OPTIONS_JSON};

        function getMovedItems() {{
            try {{ return JSON.parse(localStorage.getItem(MOVED_KEY) || '{{"out":[],"in":[]}}'); }}
            catch(e) {{ return {{out:[], in:[]}}; }}
        }}
        function saveMovedItems(moved) {{
            localStorage.setItem(MOVED_KEY, JSON.stringify(moved));
        }}

        function buildMoveDropdown(section, idx) {{
            const id = `move_${{section}}_${{idx}}`;
            let html = `<select id="${{id}}" onchange="moveItemToMonth('${{section}}', ${{idx}}, this.value); this.value='';" style="font-size:0.7rem;padding:2px 4px;border:1px solid #d1d5db;border-radius:4px;color:#6b7280;background:white;cursor:pointer;max-width:90px;">`;
            html += `<option value="">Move to...</option>`;
            MONTH_OPTIONS.forEach(m => {{
                html += `<option value="${{m.key}}">${{m.label}}</option>`;
            }});
            html += `</select>`;
            return html;
        }}

        function moveItemToMonth(section, idx, targetKey) {{
            if (!targetKey) return;
            const targetLabel = MONTH_OPTIONS.find(m => m.key === targetKey)?.label || targetKey;

            // Get the item data
            let item;
            if (section === 'other') item = otherData[idx];
            else if (section === 'cc') item = ccData[idx];
            if (!item) return;

            // Save to current month's "out" list
            const moved = getMovedItems();
            moved.out.push({{
                section,
                idx,
                item,
                target_month: targetKey,
                target_label: targetLabel,
                from_month: PERIOD_KEY,
                from_label: PERIOD_LABEL,
                timestamp: new Date().toISOString()
            }});
            saveMovedItems(moved);

            // Also save to target month's "in" list
            const targetMovedKey = `cfa_recon_${{targetKey}}_moved`;
            let targetMoved;
            try {{ targetMoved = JSON.parse(localStorage.getItem(targetMovedKey) || '{{"out":[],"in":[]}}'); }}
            catch(e) {{ targetMoved = {{out:[], in:[]}}; }}
            targetMoved.in.push({{
                section,
                item,
                from_month: PERIOD_KEY,
                from_label: PERIOD_LABEL,
                timestamp: new Date().toISOString()
            }});
            localStorage.setItem(targetMovedKey, JSON.stringify(targetMoved));

            showToast(`Moved to ${{targetLabel}}`);
            refreshAllTables();
        }}

        function undoMoveOut(moveIdx) {{
            const moved = getMovedItems();
            const entry = moved.out[moveIdx];
            if (!entry) return;

            // Remove from target month's "in" list
            const targetMovedKey = `cfa_recon_${{entry.target_month}}_moved`;
            try {{
                const targetMoved = JSON.parse(localStorage.getItem(targetMovedKey) || '{{"out":[],"in":[]}}');
                targetMoved.in = targetMoved.in.filter(i => i.timestamp !== entry.timestamp);
                localStorage.setItem(targetMovedKey, JSON.stringify(targetMoved));
            }} catch(e) {{}}

            // Remove from current month's "out" list
            moved.out.splice(moveIdx, 1);
            saveMovedItems(moved);
            showToast('Move undone');
            refreshAllTables();
        }}

        function undoMoveIn(moveIdx) {{
            const moved = getMovedItems();
            const entry = moved.in[moveIdx];
            if (!entry) return;

            // Remove from source month's "out" list
            const srcMovedKey = `cfa_recon_${{entry.from_month}}_moved`;
            try {{
                const srcMoved = JSON.parse(localStorage.getItem(srcMovedKey) || '{{"out":[],"in":[]}}');
                srcMoved.out = srcMoved.out.filter(o => o.timestamp !== entry.timestamp);
                localStorage.setItem(srcMovedKey, JSON.stringify(srcMoved));
            }} catch(e) {{}}

            // Remove from current month's "in" list
            moved.in.splice(moveIdx, 1);
            saveMovedItems(moved);
            showToast('Item returned to original month');
            refreshAllTables();
        }}

        function isMovedOut(section, idx) {{
            const moved = getMovedItems();
            return moved.out.some(m => m.section === section && m.idx === idx);
        }}

        function populateMovedSection() {{
            const moved = getMovedItems();

            // Moved OUT section
            const outBody = document.getElementById('movedOutTable');
            const outEmpty = document.getElementById('movedOutEmpty');
            const outBadge = document.getElementById('movedOutBadge');
            if (outBody) {{
                outBody.innerHTML = '';
                if (moved.out.length === 0) {{
                    outEmpty.style.display = 'block';
                    outBadge.textContent = '0';
                }} else {{
                    outEmpty.style.display = 'none';
                    outBadge.textContent = moved.out.length;
                    moved.out.forEach((entry, mi) => {{
                        const tr = document.createElement('tr');
                        const item = entry.item;
                        const vendorOrDesc = item.vendor || item.description || '';
                        tr.innerHTML = `
                            <td style="text-align:center"><button class="recon-unmatch-btn" onclick="undoMoveOut(${{mi}})" title="Undo move">↩</button></td>
                            <td>${{item.date}}</td>
                            <td><strong>${{escapeHtml(vendorOrDesc)}}</strong></td>
                            <td style="text-align:right"><strong>${{fmtMoney(item.amount)}}</strong></td>
                            <td><span style="font-size:0.75rem;color:#6b7280;">${{entry.section === 'other' ? 'GASTOS' : 'CC Charge'}}</span></td>
                            <td><span style="background:#dbeafe;color:#1e40af;padding:2px 8px;border-radius:9999px;font-size:0.75rem;font-weight:600;">→ ${{escapeHtml(entry.target_label)}}</span></td>
                        `;
                        outBody.appendChild(tr);
                    }});
                }}
            }}

            // Moved IN section
            const inBody = document.getElementById('movedInTable');
            const inEmpty = document.getElementById('movedInEmpty');
            const inBadge = document.getElementById('movedInBadge');
            if (inBody) {{
                inBody.innerHTML = '';
                if (moved.in.length === 0) {{
                    inEmpty.style.display = 'block';
                    inBadge.textContent = '0';
                }} else {{
                    inEmpty.style.display = 'none';
                    inBadge.textContent = moved.in.length;
                    moved.in.forEach((entry, mi) => {{
                        const tr = document.createElement('tr');
                        const item = entry.item;
                        const vendorOrDesc = item.vendor || item.description || '';
                        tr.innerHTML = `
                            <td style="text-align:center"><button class="recon-unmatch-btn" onclick="undoMoveIn(${{mi}})" title="Return to original month">↩</button></td>
                            <td>${{item.date}}</td>
                            <td><strong>${{escapeHtml(vendorOrDesc)}}</strong></td>
                            <td style="text-align:right"><strong>${{fmtMoney(item.amount)}}</strong></td>
                            <td><span style="font-size:0.75rem;color:#6b7280;">${{entry.section === 'other' ? 'GASTOS' : 'CC Charge'}}</span></td>
                            <td><span style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:9999px;font-size:0.75rem;font-weight:600;">← ${{escapeHtml(entry.from_label)}}</span></td>
                        `;
                        inBody.appendChild(tr);
                    }});
                }}
            }}
        }}

        function populateOtherTable(data) {{
            const tbody = document.getElementById('otherTable');
            tbody.innerHTML = '';
            const reviewed = getReviewed();
            const lookup = buildReconMatchLookup();
            const hasCCSelection = reconSelectedCC.length > 0;
            let visibleCount = 0;

            data.forEach((row, i) => {{
                const key = 'other_' + row.date + '_' + row.amount + '_' + (row.invoice||i);
                if (reviewed[key]) return;
                if (isMovedOut('other', i)) return;
                const tr = document.createElement('tr');
                const isSelected = reconSelectedGastos.some(s => s.idx === i);
                const matchInfo = lookup.otherToMatch[i];
                const moveBtn = buildMoveDropdown('other', i);
                const days = getAgingDays(row.date);
                const agingCell = `<td style="text-align:center">${{agingBadge(days)}}${{otherDuplicates.has(i) ? '<span class="dup-flag">DUP?</span>' : ''}}</td>`;

                if (matchInfo) {{
                    return;  // Hide matched items — they appear in Matched Transactions section
                }} else if (reconMode === 'cc_to_gastos' && hasCCSelection) {{
                    tr.className = 'recon-cc-clickable';
                    tr.onclick = () => selectReconGastos(i, row);
                    tr.innerHTML = `
                        <td style="text-align:center"><input type="checkbox" class="review-cb" data-key="${{key}}" data-section="other" data-idx="${{i}}" onchange="markReviewed(this)" onclick="event.stopPropagation()"></td>
                        <td>${{row.date}}</td>
                        <td><strong>${{escapeHtml(row.vendor)}}</strong></td>
                        <td>${{escapeHtml(row.category)}}</td>
                        <td style="text-align:right"><strong>${{fmtMoney(row.amount)}}</strong></td>
                        <td>${{escapeHtml(row.invoice)}}</td>
                        ${{agingCell}}
                        <td style="text-align:center"><span style="color:#7c3aed; font-weight:600; font-size:0.8rem;">Click to link</span></td>
                    `;
                }} else if (isSelected) {{
                    tr.className = 'recon-selected recon-selectable';
                    tr.onclick = () => selectReconGastos(i, row);
                    tr.innerHTML = `
                        <td style="text-align:center"><input type="checkbox" class="review-cb" data-key="${{key}}" data-section="other" data-idx="${{i}}" onchange="markReviewed(this)" onclick="event.stopPropagation()"></td>
                        <td>${{row.date}}</td>
                        <td><strong>${{escapeHtml(row.vendor)}}</strong></td>
                        <td>${{escapeHtml(row.category)}}</td>
                        <td style="text-align:right"><strong>${{fmtMoney(row.amount)}}</strong></td>
                        <td>${{escapeHtml(row.invoice)}}</td>
                        ${{agingCell}}
                        <td style="text-align:center"><span style="color:#2563eb; font-weight:600; font-size:0.8rem;">Selected</span></td>
                    `;
                }} else if (reconMode === 'gastos_to_cc') {{
                    tr.className = 'recon-selectable';
                    tr.onclick = () => selectReconGastos(i, row);
                    tr.innerHTML = `
                        <td style="text-align:center"><input type="checkbox" class="review-cb" data-key="${{key}}" data-section="other" data-idx="${{i}}" onchange="markReviewed(this)" onclick="event.stopPropagation()"></td>
                        <td>${{row.date}}</td>
                        <td><strong>${{escapeHtml(row.vendor)}}</strong></td>
                        <td>${{escapeHtml(row.category)}}</td>
                        <td style="text-align:right"><strong>${{fmtMoney(row.amount)}}</strong></td>
                        <td>${{escapeHtml(row.invoice)}}</td>
                        ${{agingCell}}
                        <td style="text-align:center" onclick="event.stopPropagation();">${{moveBtn}}</td>
                    `;
                }} else {{
                    tr.innerHTML = `
                        <td style="text-align:center"><input type="checkbox" class="review-cb" data-key="${{key}}" data-section="other" data-idx="${{i}}" onchange="markReviewed(this)"></td>
                        <td>${{row.date}}</td>
                        <td><strong>${{escapeHtml(row.vendor)}}</strong></td>
                        <td>${{escapeHtml(row.category)}}</td>
                        <td style="text-align:right"><strong>${{fmtMoney(row.amount)}}</strong></td>
                        <td>${{escapeHtml(row.invoice)}}</td>
                        ${{agingCell}}
                        <td style="text-align:center">${{moveBtn}}</td>
                    `;
                }}
                tbody.appendChild(tr);
                visibleCount++;
            }});
            document.getElementById('otherCount').textContent = visibleCount + ' of ' + otherData.length + ' shown';
        }}

        function populateCCTable(data) {{
            const tbody = document.getElementById('ccTable');
            tbody.innerHTML = '';
            const reviewed = getReviewed();
            const lookup = buildReconMatchLookup();
            const hasGastosSelection = reconSelectedGastos.length > 0;
            const isCCSelected = (idx) => reconSelectedCC.some(s => s.idx === idx);
            let visibleCount = 0;

            data.forEach((row, i) => {{
                const key = 'cc_' + row.date + '_' + row.amount + '_' + (row.description||'').substring(0,20);
                if (reviewed[key]) return;
                if (isMovedOut('cc', i)) return;
                const tr = document.createElement('tr');
                const matchInfo = lookup.ccToMatch[i];
                const moveBtn = buildMoveDropdown('cc', i);
                const days = getAgingDays(row.date);
                const agingCell = `<td style="text-align:center">${{agingBadge(days)}}${{ccDuplicates.has(i) ? '<span class="dup-flag">DUP?</span>' : ''}}</td>`;

                if (matchInfo) {{
                    return;  // Hide matched items — they appear in Matched Transactions section
                }} else if (reconMode === 'cc_to_gastos' && isCCSelected(i)) {{
                    tr.className = 'recon-selected recon-selectable';
                    tr.onclick = () => selectReconCC(i, row);
                    tr.innerHTML = `
                        <td style="text-align:center"><input type="checkbox" class="review-cb" data-key="${{key}}" data-section="cc" data-idx="${{i}}" onchange="markReviewed(this)" onclick="event.stopPropagation()"></td>
                        <td>${{row.date}}</td>
                        <td><strong>${{escapeHtml(row.description)}}</strong></td>
                        <td style="text-align:right"><strong>${{fmtMoney(row.amount)}}</strong></td>
                        <td>${{sourceBadge(row.source)}}</td>
                        <td>${{escapeHtml(row.category || '')}}</td>
                        ${{agingCell}}
                        <td style="text-align:center"><span style="color:#2563eb; font-weight:600; font-size:0.8rem;">Selected</span></td>
                    `;
                }} else if (reconMode === 'cc_to_gastos') {{
                    tr.className = 'recon-selectable';
                    tr.onclick = () => selectReconCC(i, row);
                    tr.innerHTML = `
                        <td style="text-align:center"><input type="checkbox" class="review-cb" data-key="${{key}}" data-section="cc" data-idx="${{i}}" onchange="markReviewed(this)" onclick="event.stopPropagation()"></td>
                        <td>${{row.date}}</td>
                        <td><strong>${{escapeHtml(row.description)}}</strong></td>
                        <td style="text-align:right"><strong>${{fmtMoney(row.amount)}}</strong></td>
                        <td>${{sourceBadge(row.source)}}</td>
                        <td>${{escapeHtml(row.category || '')}}</td>
                        ${{agingCell}}
                        <td style="text-align:center" onclick="event.stopPropagation();">${{moveBtn}}</td>
                    `;
                }} else if (hasGastosSelection) {{
                    tr.className = 'recon-cc-clickable';
                    tr.onclick = () => selectReconCC(i, row);
                    tr.innerHTML = `
                        <td style="text-align:center"><input type="checkbox" class="review-cb" data-key="${{key}}" data-section="cc" data-idx="${{i}}" onchange="markReviewed(this)" onclick="event.stopPropagation()"></td>
                        <td>${{row.date}}</td>
                        <td><strong>${{escapeHtml(row.description)}}</strong></td>
                        <td style="text-align:right"><strong>${{fmtMoney(row.amount)}}</strong></td>
                        <td>${{sourceBadge(row.source)}}</td>
                        <td>${{escapeHtml(row.category || '')}}</td>
                        ${{agingCell}}
                        <td style="text-align:center"><span style="color:#7c3aed; font-weight:600; font-size:0.8rem;">Click to link</span></td>
                    `;
                }} else {{
                    tr.innerHTML = `
                        <td style="text-align:center"><input type="checkbox" class="review-cb" data-key="${{key}}" data-section="cc" data-idx="${{i}}" onchange="markReviewed(this)"></td>
                        <td>${{row.date}}</td>
                        <td><strong>${{escapeHtml(row.description)}}</strong></td>
                        <td style="text-align:right"><strong>${{fmtMoney(row.amount)}}</strong></td>
                        <td>${{sourceBadge(row.source)}}</td>
                        <td>${{escapeHtml(row.category || '')}}</td>
                        ${{agingCell}}
                        <td style="text-align:center">${{moveBtn}}</td>
                    `;
                }}
                tbody.appendChild(tr);
                visibleCount++;
            }});
            document.getElementById('ccCount').textContent = visibleCount + ' of ' + ccData.length + ' shown';
        }}

        // ===== MAIN TAB SWITCHING =====
        function switchMainTab(tab) {{
            const reconTab = document.getElementById('reconTab');
            const bulkTab = document.getElementById('bulkTab');
            const btns = document.querySelectorAll('.main-tab');
            btns.forEach(b => b.classList.remove('active'));
            if (tab === 'recon') {{
                reconTab.style.display = 'block';
                bulkTab.style.display = 'none';
                btns[0].classList.add('active');
            }} else {{
                reconTab.style.display = 'none';
                bulkTab.style.display = 'block';
                btns[1].classList.add('active');
                // Populate active vendor panel on first switch
                populateAllVendorPanels();
            }}
        }}

        // ===== VENDOR SUB-TAB SWITCHING =====
        let vendorPanelsPopulated = false;
        const VENDORS = ['COCA COLA PUERTO RICO', 'FRESHPOINT', 'HOLSUM DE PUERTO RICO', 'PR COFFEE ROASTERS', 'TRES MONJITAS'];
        const MATCH_STORAGE_KEY = 'cfa_recon_{PERIOD_KEY}_bulk_matches';

        function switchVendorTab(vendor) {{
            document.querySelectorAll('.vendor-sub-tab').forEach(b => b.classList.remove('active'));
            const btns = document.querySelectorAll('.vendor-sub-tab');
            const idx = VENDORS.indexOf(vendor);
            if (idx >= 0 && btns[idx]) btns[idx].classList.add('active');
            document.querySelectorAll('.vendor-panel').forEach(p => p.classList.remove('active'));
            const panelId = 'panel_' + vendor.replace(/ /g, '_');
            const panel = document.getElementById(panelId);
            if (panel) panel.classList.add('active');
            // Cancel any selection in progress
            cancelSelection(vendor.replace(/ /g, '_'));
        }}

        // ===== MANUAL MATCH STORAGE =====
        function getManualMatches() {{
            try {{ return JSON.parse(localStorage.getItem(MATCH_STORAGE_KEY) || '{{}}'); }}
            catch(e) {{ return {{}}; }}
        }}
        function saveManualMatches(matches) {{
            localStorage.setItem(MATCH_STORAGE_KEY, JSON.stringify(matches));
        }}

        // ===== CLICK-TO-LINK STATE (supports multi-select GASTOS → one target) =====
        let selectedGastos = [];  // array of {{ vendor, idx, row }}
        let selectedVendorKey = null;

        function updateToolbar(vkey) {{
            const label = document.getElementById('matchModeLabel_' + vkey);
            const cancelBtn = document.getElementById('cancelBtn_' + vkey);
            if (!label) return;
            if (selectedGastos.length === 0) {{
                label.textContent = 'Click GASTOS rows to select (multiple allowed), then click an invoice or CC charge to link';
                if (cancelBtn) cancelBtn.style.display = 'none';
            }} else {{
                const total = selectedGastos.reduce((s, g) => s + g.row.amount, 0);
                const count = selectedGastos.length;
                const rowLabel = count === 1 ? '1 GASTOS row' : count + ' GASTOS rows';
                label.innerHTML = `<strong>${{rowLabel}}</strong> selected (${{fmtMoney(total)}}) — click an invoice or CC charge to link them`;
                if (cancelBtn) cancelBtn.style.display = 'inline-block';
            }}
        }}

        function selectGastosRow(vendor, idx, row, trEl) {{
            const vkey = vendor.replace(/ /g, '_');
            // If already matched in a group, don't allow re-selection
            const matches = getManualMatches();
            const vendorMatches = matches[vendor] || [];
            if (vendorMatches.some(m => (m.gastos_indices || [m.gastos_idx]).includes(idx))) return;

            // If switching vendors, reset
            if (selectedVendorKey && selectedVendorKey !== vkey) {{
                cancelSelection(selectedVendorKey);
            }}
            selectedVendorKey = vkey;

            // Toggle selection: if already selected, deselect; otherwise add
            const existingIdx = selectedGastos.findIndex(g => g.idx === idx);
            if (existingIdx >= 0) {{
                selectedGastos.splice(existingIdx, 1);
                trEl.classList.remove('row-selected');
            }} else {{
                selectedGastos.push({{ vendor, idx, row }});
                trEl.classList.add('row-selected');
            }}

            updateToolbar(vkey);
        }}

        function selectInvoiceRow(vendor, idx, inv, trEl) {{
            const vkey = vendor.replace(/ /g, '_');
            if (selectedGastos.length === 0 || selectedGastos[0].vendor !== vendor) {{
                const label = document.getElementById('matchModeLabel_' + vkey);
                if (label) label.textContent = 'Please click GASTOS row(s) first, then click an invoice to link';
                return;
            }}

            const matches = getManualMatches();
            const vendorMatches = matches[vendor] || [];
            if (vendorMatches.some(m => m.invoice_idx === idx)) return;

            // Create grouped match
            const gastosIndices = selectedGastos.map(g => g.idx);
            const gastosAmounts = selectedGastos.map(g => g.row.amount);
            const gastosTotal = gastosAmounts.reduce((s, a) => s + a, 0);

            const newMatch = {{
                gastos_indices: gastosIndices,
                gastos_amounts: gastosAmounts,
                gastos_total: gastosTotal,
                invoice_idx: idx,
                invoice_amount: inv.amount,
                invoice_date: inv.date || '',
                vendor_invoice: inv.invoice_number || '',
                diff: Math.round((gastosTotal - inv.amount) * 100) / 100,
                timestamp: new Date().toISOString(),
            }};

            if (!matches[vendor]) matches[vendor] = [];
            matches[vendor].push(newMatch);
            saveManualMatches(matches);

            selectedGastos = [];
            selectedVendorKey = null;
            renderVendorPanel(vendor);
        }}

        function selectCCRow(vendor, idx, cc, trEl) {{
            const vkey = vendor.replace(/ /g, '_');
            if (selectedGastos.length === 0 || selectedGastos[0].vendor !== vendor) {{
                const label = document.getElementById('matchModeLabel_' + vkey);
                if (label) label.textContent = 'Please click GASTOS row(s) first, then click a CC charge to link';
                return;
            }}

            const matches = getManualMatches();
            const vendorMatches = matches[vendor] || [];
            if (vendorMatches.some(m => m.cc_idx === idx)) return;

            const gastosIndices = selectedGastos.map(g => g.idx);
            const gastosAmounts = selectedGastos.map(g => g.row.amount);
            const gastosTotal = gastosAmounts.reduce((s, a) => s + a, 0);

            const newMatch = {{
                gastos_indices: gastosIndices,
                gastos_amounts: gastosAmounts,
                gastos_total: gastosTotal,
                cc_idx: idx,
                cc_amount: cc.amount,
                cc_date: cc.date,
                cc_description: cc.description || '',
                cc_source: cc.source || '',
                diff: Math.round((gastosTotal - cc.amount) * 100) / 100,
                timestamp: new Date().toISOString(),
            }};

            if (!matches[vendor]) matches[vendor] = [];
            matches[vendor].push(newMatch);
            saveManualMatches(matches);

            selectedGastos = [];
            selectedVendorKey = null;
            renderVendorPanel(vendor);
        }}

        function cancelSelection(vkey) {{
            selectedGastos = [];
            selectedVendorKey = null;
            const gastosBody = document.getElementById('vendorGastos_' + vkey);
            if (gastosBody) gastosBody.querySelectorAll('tr').forEach(r => r.classList.remove('row-selected'));
            updateToolbar(vkey);
        }}

        function unmatchGroup(vendor, matchIdx) {{
            const matches = getManualMatches();
            if (matches[vendor] && matches[vendor][matchIdx]) {{
                matches[vendor].splice(matchIdx, 1);
                saveManualMatches(matches);
            }}
            renderVendorPanel(vendor);
        }}

        // ===== RENDER A SINGLE VENDOR PANEL =====
        function renderVendorPanel(vendor) {{
            const vkey = vendor.replace(/ /g, '_');
            const items = bulkByVendor[vendor] || [];
            const invItems = invoiceData[vendor] || [];
            const matches = getManualMatches();
            const vendorMatches = matches[vendor] || [];
            const reviewed = getReviewed();

            // Build lookup sets — handles both new grouped format (gastos_indices) and legacy (gastos_idx)
            const matchedGastosIdx = new Set();
            const matchedInvoiceIdx = new Set(vendorMatches.filter(m => m.invoice_idx !== undefined).map(m => m.invoice_idx));
            const matchedCCIdx = new Set(vendorMatches.filter(m => m.cc_idx !== undefined).map(m => m.cc_idx));

            // Color mapping: each match group gets a color class
            const gastosColorMap = {{}};
            const invoiceColorMap = {{}};
            const ccColorMap = {{}};

            vendorMatches.forEach((m, i) => {{
                const colorClass = 'match-color-' + (i % 10);
                const indices = m.gastos_indices || [m.gastos_idx];
                const groupSize = indices.length;
                const diff = m.diff !== undefined ? m.diff : 0;

                indices.forEach(gIdx => {{
                    matchedGastosIdx.add(gIdx);
                    const type = m.invoice_idx !== undefined ? 'invoice' : 'cc';
                    gastosColorMap[gIdx] = {{
                        color: colorClass,
                        matchNum: i,
                        type: type,
                        groupSize: groupSize,
                        diff: diff,
                        invoiceIdx: m.invoice_idx,
                        ccIdx: m.cc_idx,
                    }};
                }});

                if (m.invoice_idx !== undefined) {{
                    invoiceColorMap[m.invoice_idx] = {{ color: colorClass, matchNum: i, groupSize: groupSize, diff: diff }};
                }}
                if (m.cc_idx !== undefined) {{
                    ccColorMap[m.cc_idx] = {{ color: colorClass, matchNum: i, groupSize: groupSize, diff: diff }};
                }}
            }});

            // ----- GASTOS TABLE -----
            const gastosBody = document.getElementById('vendorGastos_' + vkey);
            if (gastosBody) {{
                gastosBody.innerHTML = '';
                items.forEach((row, i) => {{
                    const key = 'bulk_' + row.date + '_' + row.amount + '_' + (row.invoice||i);
                    if (reviewed[key]) return;
                    const isMatched = matchedGastosIdx.has(i);
                    const colorInfo = gastosColorMap[i];
                    const tr = document.createElement('tr');
                    tr.className = 'clickable-row' + (isMatched ? ' row-matched' : '');
                    if (colorInfo) tr.classList.add(colorInfo.color);
                    if (!isMatched) {{
                        tr.onclick = () => selectGastosRow(vendor, i, row, tr);
                    }}
                    let matchCell = '';
                    if (isMatched && colorInfo) {{
                        const gLabel = colorInfo.groupSize > 1 ? ' (group of ' + colorInfo.groupSize + ')' : '';
                        const typeLabel = colorInfo.type === 'cc' ? 'CC' : 'Inv';
                        const diffNote = colorInfo.diff !== 0 ? ` <small style="color:#dc2626">Δ${{fmtMoney(Math.abs(colorInfo.diff))}}</small>` : '';
                        matchCell = `<span class="match-badge match-yes">${{typeLabel}} #${{colorInfo.matchNum + 1}}${{gLabel}}</span>${{diffNote}} <button class="unmatch-btn" onclick="event.stopPropagation(); unmatchGroup('${{vendor}}', ${{colorInfo.matchNum}})" title="Unlink group">✕</button>`;
                    }} else {{
                        matchCell = '<span class="match-badge match-pending">—</span>';
                    }}
                    tr.innerHTML = `
                        <td>${{row.date}}</td>
                        <td style="text-align:right"><strong>${{fmtMoney(row.amount)}}</strong></td>
                        <td>${{escapeHtml(row.invoice)}}</td>
                        <td style="text-align:center">${{matchCell}}</td>
                    `;
                    gastosBody.appendChild(tr);
                }});
            }}

            // ----- INVOICE TABLE -----
            if (invItems.length > 0) {{
                const placeholder = document.getElementById('invoicePlaceholder_' + vkey);
                const tableWrap = document.getElementById('invoiceTableWrap_' + vkey);
                if (placeholder) placeholder.style.display = 'none';
                if (tableWrap) tableWrap.style.display = 'block';

                const invBody = document.getElementById('vendorInvoice_' + vkey);
                if (invBody) {{
                    invBody.innerHTML = '';
                    invItems.forEach((inv, j) => {{
                        const isMatched = matchedInvoiceIdx.has(j);
                        const colorInfo = invoiceColorMap[j];
                        const tr = document.createElement('tr');
                        tr.className = 'clickable-row' + (isMatched ? ' row-matched' : '');
                        if (colorInfo) tr.classList.add(colorInfo.color);
                        if (!isMatched) {{
                            tr.onclick = () => selectInvoiceRow(vendor, j, inv, tr);
                        }}
                        let matchCell = '';
                        if (isMatched && colorInfo) {{
                            const gLabel = colorInfo.groupSize > 1 ? ' (' + colorInfo.groupSize + ' GASTOS)' : '';
                            const diffNote = colorInfo.diff !== 0 ? ` <small style="color:#dc2626">Δ${{fmtMoney(Math.abs(colorInfo.diff))}}</small>` : '';
                            matchCell = `<span class="match-badge match-yes">#${{colorInfo.matchNum + 1}}${{gLabel}}</span>${{diffNote}} <button class="unmatch-btn" onclick="event.stopPropagation(); unmatchGroup('${{vendor}}', ${{colorInfo.matchNum}})" title="Unlink">✕</button>`;
                        }} else {{
                            matchCell = '<span class="match-badge match-no">—</span>';
                        }}
                        tr.innerHTML = `
                            <td>${{inv.date || '-'}}</td>
                            <td style="text-align:right"><strong>${{fmtMoney(inv.amount)}}</strong></td>
                            <td>${{escapeHtml(inv.invoice_number || '')}}</td>
                            <td style="text-align:center">${{matchCell}}</td>
                        `;
                        invBody.appendChild(tr);
                    }});
                }}
            }} else {{
                const placeholder = document.getElementById('invoicePlaceholder_' + vkey);
                const tableWrap = document.getElementById('invoiceTableWrap_' + vkey);
                if (placeholder) placeholder.style.display = 'block';
                if (tableWrap) tableWrap.style.display = 'none';
            }}

            // ----- CC CHARGES TABLE -----
            const ccItems = ccByVendor[vendor] || [];
            const ccSection = document.getElementById('vendorCCSection_' + vkey);
            if (ccItems.length > 0 && ccSection) {{
                ccSection.style.display = 'block';
                const ccBody = document.getElementById('vendorCC_' + vkey);
                if (ccBody) {{
                    ccBody.innerHTML = '';
                    ccItems.forEach((cc, j) => {{
                        const isMatched = matchedCCIdx.has(j);
                        const colorInfo = ccColorMap[j];
                        const tr = document.createElement('tr');
                        tr.className = 'clickable-row' + (isMatched ? ' row-matched' : '');
                        if (colorInfo) tr.classList.add(colorInfo.color);
                        if (!isMatched) {{
                            tr.onclick = () => selectCCRow(vendor, j, cc, tr);
                        }}
                        let matchCell = '';
                        if (isMatched && colorInfo) {{
                            const gLabel = colorInfo.groupSize > 1 ? ' (' + colorInfo.groupSize + ' GASTOS)' : '';
                            const diffNote = colorInfo.diff !== 0 ? ` <small style="color:#dc2626">Δ${{fmtMoney(Math.abs(colorInfo.diff))}}</small>` : '';
                            matchCell = `<span class="match-badge match-yes">#${{colorInfo.matchNum + 1}}${{gLabel}}</span>${{diffNote}} <button class="unmatch-btn" onclick="event.stopPropagation(); unmatchGroup('${{vendor}}', ${{colorInfo.matchNum}})" title="Unlink">✕</button>`;
                        }} else {{
                            matchCell = '<span class="match-badge match-no">—</span>';
                        }}
                        tr.innerHTML = `
                            <td>${{cc.date}}</td>
                            <td><small>${{escapeHtml(cc.description)}}</small></td>
                            <td style="text-align:right"><strong>${{fmtMoney(cc.amount)}}</strong></td>
                            <td>${{sourceBadge(cc.source)}}</td>
                            <td style="text-align:center">${{matchCell}}</td>
                        `;
                        ccBody.appendChild(tr);
                    }});
                }}
            }}

            // ----- UPDATE STATS -----
            const matchedGastosCount = matchedGastosIdx.size;  // count unique GASTOS rows matched
            const groupCount = vendorMatches.length;  // count match groups
            const statEl = document.getElementById('statMatched_' + vkey);
            if (statEl) {{
                statEl.textContent = matchedGastosCount + ' / ' + items.length;
                statEl.style.color = matchedGastosCount > 0 ? '#16a34a' : '#9ca3af';
            }}
            const statsLabel = document.getElementById('matchStats_' + vkey);
            if (statsLabel) {{
                const matchedTotal = vendorMatches.reduce((s, m) => s + (m.gastos_total || m.gastos_amount || 0), 0);
                const pct = items.length > 0 ? Math.round(matchedGastosCount / items.length * 100) : 0;
                const groupLabel = groupCount !== matchedGastosCount ? ` (${{groupCount}} groups)` : '';
                statsLabel.textContent = `${{matchedGastosCount}} matched${{groupLabel}} (${{fmtMoney(matchedTotal)}}) · ${{pct}}% reconciled`;
            }}

            // Reset toolbar after render
            updateToolbar(vkey);
        }}

        // ===== POPULATE ALL VENDOR PANELS =====
        function populateAllVendorPanels() {{
            if (vendorPanelsPopulated) return;
            vendorPanelsPopulated = true;
            VENDORS.forEach(vendor => renderVendorPanel(vendor));
        }}

        // ===== REVIEWED ITEMS MANAGEMENT =====
        const STORAGE_KEY = 'cfa_recon_{PERIOD_KEY}_reviewed';

        function getReviewed() {{
            try {{ return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{{}}'); }}
            catch(e) {{ return {{}}; }}
        }}

        function saveReviewed(reviewed) {{
            localStorage.setItem(STORAGE_KEY, JSON.stringify(reviewed));
        }}

        function markReviewed(cb) {{
            const key = cb.dataset.key;
            const section = cb.dataset.section;
            const reviewed = getReviewed();

            // Look up the original row data
            let rowData = null;
            const idx = parseInt(cb.dataset.idx);
            if (section === 'bulk') rowData = bulkData[idx];
            else if (section === 'other') rowData = otherData[idx];
            else if (section === 'cc') rowData = ccData[idx];

            if (rowData) {{
                reviewed[key] = {{ section, ...rowData }};
                saveReviewed(reviewed);
            }}

            // Refresh all tables
            refreshAllTables();
        }}

        function unreview(key) {{
            const reviewed = getReviewed();
            delete reviewed[key];
            saveReviewed(reviewed);
            refreshAllTables();
        }}

        function clearAllReviewed() {{
            localStorage.removeItem(STORAGE_KEY);
            refreshAllTables();
        }}

        function populateReviewedTable() {{
            const reviewed = getReviewed();
            const entries = Object.entries(reviewed);
            const tbody = document.getElementById('reviewedTable');
            const emptyMsg = document.getElementById('reviewedEmpty');
            const badge = document.getElementById('reviewedBadge');
            tbody.innerHTML = '';

            if (entries.length === 0) {{
                emptyMsg.style.display = 'block';
                badge.textContent = '0';
                return;
            }}
            emptyMsg.style.display = 'none';
            badge.textContent = entries.length;

            entries.forEach(([key, row]) => {{
                const tr = document.createElement('tr');
                const vendorOrDesc = row.vendor || row.description || '';
                const source = row.source || (row.section === 'bulk' ? 'PORO GUSTO' : row.section === 'other' ? 'Gastos' : '');
                tr.innerHTML = `
                    <td style="text-align:center"><button class="review-btn" onclick="unreview('${{key}}')" title="Move back to unmatched">&#x21A9;</button></td>
                    <td>${{row.date}}</td>
                    <td><strong>${{escapeHtml(vendorOrDesc)}}</strong></td>
                    <td>${{escapeHtml(row.category || '')}}</td>
                    <td style="text-align:right"><strong>${{fmtMoney(row.amount)}}</strong></td>
                    <td><small>${{escapeHtml(source)}}</small></td>
                `;
                tbody.appendChild(tr);
            }});
        }}

        function refreshAllTables() {{
            filterTable('matched');
            filterTable('other');
            filterTable('cc');
            populateReviewedTable();
            populateMovedSection();
            updateReconToolbar();
            updateReconProgress();
            // Re-render vendor panels if they've been initialized
            if (vendorPanelsPopulated) {{
                VENDORS.forEach(vendor => renderVendorPanel(vendor));
            }}
        }}

        // ===== FILTERING =====
        function filterTable(section) {{
            if (section === 'matched') {{
                const search = document.getElementById('matchedSearch').value.toLowerCase();
                const vendorFilter = document.getElementById('matchedVendorFilter').value;
                const srcFilter = document.getElementById('matchedSourceFilter').value;
                const tierFilter = document.getElementById('matchedTierFilter').value;
                const filtered = matchedData.filter(r => {{
                    if (search && !(r.exp_vendor||'').toLowerCase().includes(search) && !(r.exp_category||'').toLowerCase().includes(search) && !(r.match_desc||'').toLowerCase().includes(search)) return false;
                    if (vendorFilter && (r.exp_vendor||'') !== vendorFilter) return false;
                    if (srcFilter && !(r.match_source||'').includes(srcFilter)) return false;
                    if (tierFilter && String(r.tier) !== tierFilter) return false;
                    return true;
                }});
                populateMatchedTable(filtered);
            }}
            else if (section === 'other') {{
                const search = document.getElementById('otherSearch').value.toLowerCase();
                const vendorFilter = document.getElementById('otherVendorFilter').value;
                const catFilter = document.getElementById('otherCatFilter').value;
                const filtered = otherData.filter(r => {{
                    if (search && !(r.vendor||'').toLowerCase().includes(search) && !(r.category||'').toLowerCase().includes(search)) return false;
                    if (vendorFilter && (r.vendor||'') !== vendorFilter) return false;
                    if (catFilter && r.category !== catFilter) return false;
                    return true;
                }});
                populateOtherTable(filtered);
            }}
            else if (section === 'cc') {{
                const search = document.getElementById('ccSearch').value.toLowerCase();
                const srcFilter = document.getElementById('ccSourceFilter').value;
                const filtered = ccData.filter(r => {{
                    if (search && !(r.description||'').toLowerCase().includes(search)) return false;
                    if (srcFilter && !(r.source||'').includes(srcFilter)) return false;
                    return true;
                }});
                populateCCTable(filtered);
            }}
        }}

        // ===== SORTING =====
        let sortState = {{}};  // track sort direction per table+col

        function handleSort(tableSection, colIdx) {{
            const key = tableSection + '_' + colIdx;
            const asc = sortState[key] === 'asc' ? 'desc' : 'asc';
            sortState[key] = asc;

            // Clear sort indicators for this section
            document.querySelectorAll(`[data-table="${{tableSection}}"]`).forEach(th => {{
                th.classList.remove('sort-asc', 'sort-desc');
            }});
            // Set current indicator
            const activeTh = document.querySelector(`[data-table="${{tableSection}}"][data-col="${{colIdx}}"]`);
            if (activeTh) activeTh.classList.add(asc === 'asc' ? 'sort-asc' : 'sort-desc');

            // Get the tbody and sort rows
            const tbodyMap = {{ matched: 'matchedTable', other: 'otherTable', cc: 'ccTable' }};
            const tbody = document.getElementById(tbodyMap[tableSection]);
            if (!tbody) return;
            const rows = Array.from(tbody.querySelectorAll('tr'));

            rows.sort((a, b) => {{
                let aVal = a.cells[colIdx] ? a.cells[colIdx].textContent.trim().replace(/[$,]/g, '') : '';
                let bVal = b.cells[colIdx] ? b.cells[colIdx].textContent.trim().replace(/[$,]/g, '') : '';
                const aNum = parseFloat(aVal);
                const bNum = parseFloat(bVal);
                if (!isNaN(aNum) && !isNaN(bNum)) {{
                    return asc === 'asc' ? aNum - bNum : bNum - aNum;
                }}
                return asc === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
            }});
            rows.forEach(row => tbody.appendChild(row));
        }}

        // Attach sort handlers to all sortable headers
        document.addEventListener('DOMContentLoaded', () => {{
            document.querySelectorAll('.sortable').forEach(th => {{
                th.addEventListener('click', () => {{
                    const tbl = th.dataset.table;
                    const col = parseInt(th.dataset.col);
                    handleSort(tbl, col);
                }});
            }});
        }});

        // ===== CHARTS =====
        function initCharts() {{
            if (typeof Chart === 'undefined') {{
                console.error('Chart.js not loaded — charts will be empty');
                const cc = document.getElementById('categoryChart');
                const tc = document.getElementById('tierChart');
                if (cc) cc.parentElement.innerHTML = '<p style="color:#ef4444;text-align:center;padding:20px;">Chart.js failed to load. Check your internet connection and reload.</p>';
                if (tc) tc.parentElement.innerHTML = '<p style="color:#ef4444;text-align:center;padding:20px;">Chart.js failed to load. Check your internet connection and reload.</p>';
                return;
            }}
            const colors = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#f9ca24', '#6c5ce7', '#a29bfe', '#fd79a8', '#fdcb6e', '#00b894', '#f0932b', '#eb4d4b', '#6f86d6', '#c44569'];
            const categoryCtx = document.getElementById('categoryChart');
            if (categoryCtx) {{
                // Sort categories by value descending for better bar chart readability
                const catEntries = Object.entries(categoryBreakdown).sort((a, b) => b[1] - a[1]);
                new Chart(categoryCtx.getContext('2d'), {{
                    type: 'bar',
                    data: {{
                        labels: catEntries.map(e => e[0]),
                        datasets: [{{ label: 'Amount ($)', data: catEntries.map(e => e[1]), backgroundColor: colors }}]
                    }},
                    options: {{
                        responsive: true, maintainAspectRatio: false,
                        indexAxis: 'y',
                        plugins: {{ legend: {{ display: false }} }},
                        scales: {{ x: {{ beginAtZero: true, ticks: {{ callback: v => '$' + v.toLocaleString() }} }} }}
                    }}
                }});
            }}
            const tierCtx = document.getElementById('tierChart');
            if (tierCtx) {{
                const tierOrder = ['Tier 1', 'Tier 2', 'Tier 3', 'Tier 4'];
                const tierLabels = tierOrder.filter(t => tierCounts[t] !== undefined);
                const tierValues = tierLabels.map(t => tierCounts[t]);
                const tierColors = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444'];
                new Chart(tierCtx.getContext('2d'), {{
                    type: 'bar',
                    data: {{
                        labels: tierLabels,
                        datasets: [{{ label: 'Number of Matches', data: tierValues, backgroundColor: tierColors.slice(0, tierLabels.length) }}]
                    }},
                    options: {{
                        responsive: true, maintainAspectRatio: false,
                        plugins: {{ legend: {{ display: true }} }},
                        scales: {{ y: {{ beginAtZero: true }} }}
                    }}
                }});
            }}
        }}

        // ===== DYNAMIC DROPDOWN POPULATION =====
        function populateFilterDropdowns() {{
            // Category dropdown for Other section
            const catSel = document.getElementById('otherCatFilter');
            if (catSel) {{
                const cats = [...new Set(otherData.map(r => r.category).filter(Boolean))].sort();
                cats.forEach(c => {{
                    const opt = document.createElement('option');
                    opt.value = c;
                    opt.textContent = c;
                    catSel.appendChild(opt);
                }});
            }}
            // Vendor dropdown for Matched section
            const matchedVendorSel = document.getElementById('matchedVendorFilter');
            if (matchedVendorSel) {{
                const vendors = [...new Set(matchedData.map(r => r.exp_vendor).filter(Boolean))].sort();
                vendors.forEach(v => {{
                    const opt = document.createElement('option');
                    opt.value = v;
                    opt.textContent = v;
                    matchedVendorSel.appendChild(opt);
                }});
            }}
            // Vendor dropdown for Other section
            const otherVendorSel = document.getElementById('otherVendorFilter');
            if (otherVendorSel) {{
                const vendors = [...new Set(otherData.map(r => r.vendor).filter(Boolean))].sort();
                vendors.forEach(v => {{
                    const opt = document.createElement('option');
                    opt.value = v;
                    opt.textContent = v;
                    otherVendorSel.appendChild(opt);
                }});
            }}
        }}

        // ===== RECONCILIATION STATE SAVE/LOAD =====
        const PERIOD_KEY = '{PERIOD_KEY}';
        const PERIOD_LABEL = '{MONTH_NAME} {PERIOD_YEAR}';

        function exportReconState() {{
            const state = {{
                period_key: PERIOD_KEY,
                period_label: PERIOD_LABEL,
                exported_at: new Date().toISOString(),
                bulk_matches: getManualMatches(),
                recon_matches: getReconMatches(),
                moved_items: getMovedItems(),
                reviewed_items: getReviewed(),
                notes: getReconNotes(),
            }};
            const blob = new Blob([JSON.stringify(state, null, 2)], {{ type: 'application/json' }});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `recon_state_${{PERIOD_KEY}}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            // Visual feedback
            showToast('Reconciliation state saved!');
        }}

        function importReconState(event) {{
            const file = event.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = function(e) {{
                try {{
                    const state = JSON.parse(e.target.result);
                    if (!state.period_key) {{
                        showToast('Invalid state file — missing period_key', 'error');
                        return;
                    }}
                    // Check if this state file matches the current period
                    if (state.period_key !== PERIOD_KEY) {{
                        if (!confirm(`This state file is for ${{state.period_label || state.period_key}}. You are viewing ${{PERIOD_LABEL}}. Load anyway?`)) {{
                            return;
                        }}
                    }}
                    // Import bulk matches
                    if (state.bulk_matches) {{
                        const existing = getManualMatches();
                        const merged = {{ ...existing, ...state.bulk_matches }};
                        saveManualMatches(merged);
                    }}
                    // Import recon matches (non-bulk)
                    if (state.recon_matches) {{
                        const existing = getReconMatches();
                        // Concatenate and deduplicate by timestamp
                        const existingTs = new Set(existing.map(m => m.timestamp));
                        const newMatches = state.recon_matches.filter(m => !existingTs.has(m.timestamp));
                        saveReconMatches([...existing, ...newMatches]);
                    }}
                    // Import moved items
                    if (state.moved_items) {{
                        const existing = getMovedItems();
                        const existingOutTs = new Set(existing.out.map(m => m.timestamp));
                        const existingInTs = new Set(existing.in.map(m => m.timestamp));
                        const newOut = (state.moved_items.out || []).filter(m => !existingOutTs.has(m.timestamp));
                        const newIn = (state.moved_items.in || []).filter(m => !existingInTs.has(m.timestamp));
                        saveMovedItems({{
                            out: [...existing.out, ...newOut],
                            in: [...existing.in, ...newIn]
                        }});
                    }}
                    // Import reviewed items
                    if (state.reviewed_items) {{
                        const existing = getReviewed();
                        const merged = {{ ...existing, ...state.reviewed_items }};
                        saveReviewed(merged);
                    }}
                    // Import notes
                    if (state.notes) {{
                        const existing = getReconNotes();
                        const merged = {{ ...existing, ...state.notes }};
                        saveReconNotes(merged);
                    }}
                    // Refresh all views
                    vendorPanelsPopulated = false;
                    refreshAllTables();
                    populateAllVendorPanels();
                    showToast(`State loaded: ${{Object.keys(state.bulk_matches || {{}}).length}} vendor match sets, ${{Object.keys(state.reviewed_items || {{}}).length}} reviewed items`);
                }} catch(err) {{
                    showToast('Error reading state file: ' + err.message, 'error');
                }}
            }};
            reader.readAsText(file);
            // Reset the input so the same file can be re-imported
            event.target.value = '';
        }}

        function showToast(message, type) {{
            const toast = document.createElement('div');
            toast.style.cssText = `position:fixed;bottom:24px;right:24px;padding:14px 24px;border-radius:10px;font-size:0.9rem;font-weight:600;color:white;z-index:10000;box-shadow:0 4px 12px rgba(0,0,0,0.2);transition:opacity 0.3s;`;
            toast.style.background = type === 'error' ? '#dc2626' : '#059669';
            toast.textContent = message;
            document.body.appendChild(toast);
            setTimeout(() => {{ toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }}, 3000);
        }}

        // ===== COLLAPSIBLE SECTIONS =====
        const COLLAPSE_KEY = 'cfa_recon_{PERIOD_KEY}_collapsed';

        function getCollapsedSections() {{
            try {{ return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]'); }}
            catch(e) {{ return []; }}
        }}

        function toggleSection(sectionId) {{
            const body = document.getElementById('body_' + sectionId);
            const chevron = document.getElementById('chevron_' + sectionId);
            if (!body) return;
            const collapsed = getCollapsedSections();
            const idx = collapsed.indexOf(sectionId);
            if (body.classList.contains('collapsed')) {{
                body.classList.remove('collapsed');
                chevron.classList.remove('collapsed');
                if (idx >= 0) collapsed.splice(idx, 1);
            }} else {{
                body.classList.add('collapsed');
                chevron.classList.add('collapsed');
                if (idx < 0) collapsed.push(sectionId);
            }}
            localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed));
        }}

        function restoreCollapsedSections() {{
            const collapsed = getCollapsedSections();
            collapsed.forEach(sectionId => {{
                const body = document.getElementById('body_' + sectionId);
                const chevron = document.getElementById('chevron_' + sectionId);
                if (body) body.classList.add('collapsed');
                if (chevron) chevron.classList.add('collapsed');
            }});
        }}

        // ===== RECONCILIATION PROGRESS =====
        function updateReconProgress() {{
            const reconMatches = getReconMatches();
            const bulkMatches = (typeof getBulkMatches === 'function') ? getBulkMatches() : {{}};
            // Count manual matches from non-bulk
            const manualMatchedGastos = reconMatches.reduce((s, m) => s + (m.gastos_indices || []).length, 0);
            // Count bulk manual matches
            let bulkManualMatched = 0;
            Object.values(bulkMatches).forEach(vendorMatches => {{
                if (Array.isArray(vendorMatches)) {{
                    vendorMatches.forEach(m => {{
                        bulkManualMatched += (m.gastos_indices || m.gastos_idx !== undefined ? (m.gastos_indices || [m.gastos_idx]).length : 0);
                    }});
                }}
            }});
            const reviewed = Object.keys(getReviewed()).length;
            const moved = getMovedItems();
            const movedOut = moved.out.length;

            const autoMatched = matchedData.length;
            const totalReconciled = autoMatched + manualMatchedGastos + bulkManualMatched + reviewed;
            const totalItems = matchedData.length + otherData.length + ccData.length;
            const pct = totalItems > 0 ? Math.round((totalReconciled / totalItems) * 100) : 0;

            // Dollar variance
            const matchedAmt = matchedData.reduce((s, r) => s + r.exp_amount, 0);
            const manualAmt = reconMatches.reduce((s, m) => s + (m.gastos_total || 0), 0);
            const totalReconciledAmt = matchedAmt + manualAmt;
            const totalGastosAmt = {summary['total_expenses']};
            const unreconciledAmt = totalGastosAmt - totalReconciledAmt;

            const bar = document.getElementById('reconProgressBar');
            const label = document.getElementById('reconProgressLabel');
            const pctEl = document.getElementById('reconProgressPct');
            const varianceEl = document.getElementById('reconVariance');
            const detailEl = document.getElementById('reconProgressDetail');
            const varianceDetailEl = document.getElementById('reconVarianceDetail');

            if (bar) bar.style.width = Math.min(pct, 100) + '%';
            if (label) label.textContent = pct + '% reconciled';
            if (pctEl) pctEl.textContent = totalReconciled + ' of ' + totalItems + ' items reconciled';
            if (varianceEl) varianceEl.textContent = 'Unreconciled: ' + fmtMoney(unreconciledAmt);
            if (detailEl) detailEl.textContent = `Auto: ${{autoMatched}} | Manual: ${{manualMatchedGastos}} | Bulk: ${{bulkManualMatched}} | Reviewed: ${{reviewed}} | Moved: ${{movedOut}}`;
            if (varianceDetailEl) varianceDetailEl.textContent = `Reconciled $: ${{fmtMoney(totalReconciledAmt)}} of ${{fmtMoney(totalGastosAmt)}}`;
        }}

        // ===== GLOBAL SEARCH =====
        function globalSearchHandler() {{
            const query = (document.getElementById('globalSearch').value || '').toLowerCase().trim();
            const resultsDiv = document.getElementById('globalResults');
            if (!query || query.length < 2) {{
                resultsDiv.style.display = 'none';
                return;
            }}
            const results = [];
            // Search matched
            matchedData.forEach((r, i) => {{
                if ((r.exp_vendor||'').toLowerCase().includes(query) || (r.match_desc||'').toLowerCase().includes(query) || (r.exp_category||'').toLowerCase().includes(query) || String(r.exp_amount).includes(query)) {{
                    results.push({{ section: 'Matched', vendor: r.exp_vendor, amount: r.exp_amount, date: r.exp_date, desc: r.match_desc, sectionColor: '#d1fae5', sectionText: '#065f46', target: 'matched' }});
                }}
            }});
            // Search other
            otherData.forEach((r, i) => {{
                if ((r.vendor||'').toLowerCase().includes(query) || (r.category||'').toLowerCase().includes(query) || (r.invoice||'').toLowerCase().includes(query) || String(r.amount).includes(query)) {{
                    results.push({{ section: 'Unmatched GASTOS', vendor: r.vendor, amount: r.amount, date: r.date, desc: r.category, sectionColor: '#fee2e2', sectionText: '#991b1b', target: 'other' }});
                }}
            }});
            // Search CC
            ccData.forEach((r, i) => {{
                if ((r.description||'').toLowerCase().includes(query) || (r.source||'').toLowerCase().includes(query) || String(r.amount).includes(query)) {{
                    results.push({{ section: 'CC/Bank', vendor: r.description, amount: r.amount, date: r.date, desc: r.source, sectionColor: '#e0e7ff', sectionText: '#3730a3', target: 'cc' }});
                }}
            }});

            if (results.length === 0) {{
                resultsDiv.innerHTML = '<div style="padding:16px;text-align:center;color:#9ca3af;font-size:0.85rem;">No results found</div>';
            }} else {{
                resultsDiv.innerHTML = results.slice(0, 20).map(r => `
                    <div class="global-result-item" onclick="navigateToSection('${{r.target}}')">
                        <div>
                            <strong style="font-size:0.85rem;">${{escapeHtml(r.vendor||'')}}</strong>
                            <span style="color:#6b7280;font-size:0.8rem;margin-left:8px;">${{r.date}} — ${{fmtMoney(r.amount)}}</span>
                            <br><small style="color:#9ca3af;">${{escapeHtml(r.desc||'')}}</small>
                        </div>
                        <span class="global-result-section" style="background:${{r.sectionColor}};color:${{r.sectionText}}">${{r.section}}</span>
                    </div>
                `).join('');
                if (results.length > 20) {{
                    resultsDiv.innerHTML += '<div style="padding:8px;text-align:center;color:#9ca3af;font-size:0.75rem;">+ ' + (results.length - 20) + ' more results</div>';
                }}
            }}
            resultsDiv.style.display = 'block';
        }}

        // Close global search on click outside
        document.addEventListener('click', function(e) {{
            const container = document.querySelector('.global-search-container');
            if (container && !container.contains(e.target)) {{
                document.getElementById('globalResults').style.display = 'none';
            }}
        }});

        function navigateToSection(target) {{
            document.getElementById('globalResults').style.display = 'none';
            document.getElementById('globalSearch').value = '';
            // Ensure section is expanded
            const body = document.getElementById('body_' + target);
            if (body && body.classList.contains('collapsed')) {{
                toggleSection(target);
            }}
            // Scroll to section
            const sectionEl = document.getElementById('body_' + target);
            if (sectionEl) sectionEl.scrollIntoView({{ behavior: 'smooth', block: 'start' }});
        }}

        // ===== NOTES ON MATCHES =====
        const NOTES_KEY = 'cfa_recon_{PERIOD_KEY}_notes';
        function getReconNotes() {{
            try {{ return JSON.parse(localStorage.getItem(NOTES_KEY) || '{{}}'); }}
            catch(e) {{ return {{}}; }}
        }}
        function saveReconNotes(notes) {{
            localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
        }}
        function editNote(matchType, matchIdx) {{
            const notes = getReconNotes();
            const key = matchType + '_' + matchIdx;
            const current = notes[key] || '';
            const newNote = prompt('Add a note for this match (e.g., "tip added", "partial refund pending"):', current);
            if (newNote !== null) {{
                if (newNote.trim()) {{
                    notes[key] = newNote.trim();
                }} else {{
                    delete notes[key];
                }}
                saveReconNotes(notes);
                filterTable('matched');
            }}
        }}

        // ===== AGING CALCULATION =====
        function getAgingDays(dateStr) {{
            if (!dateStr) return 0;
            const d = new Date(dateStr);
            const now = new Date();
            const diff = Math.floor((now - d) / (1000 * 60 * 60 * 24));
            return diff;
        }}
        function agingBadge(days) {{
            if (days > 30) return `<span class="aging-danger">${{days}}d</span>`;
            if (days > 14) return `<span class="aging-warn">${{days}}d</span>`;
            return `<span style="color:#6b7280;font-size:0.75rem;">${{days}}d</span>`;
        }}

        // ===== DUPLICATE DETECTION =====
        function detectDuplicates(data, getVendor, getAmount, getDate) {{
            const dupes = {{}};
            data.forEach((row, i) => {{
                const vendor = (getVendor(row) || '').toLowerCase().trim();
                const amount = getAmount(row);
                // Key by vendor prefix (first 10 chars) + amount
                const key = vendor.substring(0, 10) + '_' + Math.round(amount * 100);
                if (!dupes[key]) dupes[key] = [];
                dupes[key].push(i);
            }});
            const dupSet = new Set();
            Object.values(dupes).forEach(indices => {{
                if (indices.length > 1) {{
                    // Check if dates are within 7 days of each other
                    for (let a = 0; a < indices.length; a++) {{
                        for (let b = a + 1; b < indices.length; b++) {{
                            const dA = new Date(getDate(data[indices[a]]));
                            const dB = new Date(getDate(data[indices[b]]));
                            if (Math.abs(dA - dB) <= 7 * 24 * 60 * 60 * 1000) {{
                                dupSet.add(indices[a]);
                                dupSet.add(indices[b]);
                            }}
                        }}
                    }}
                }}
            }});
            return dupSet;
        }}

        // Pre-compute duplicate sets
        const otherDuplicates = detectDuplicates(otherData, r => r.vendor, r => r.amount, r => r.date);
        const ccDuplicates = detectDuplicates(ccData, r => r.description, r => r.amount, r => r.date);

        // ===== PRINT SUMMARY =====
        function printReconSummary() {{
            // Expand all sections before printing
            const collapsed = getCollapsedSections();
            collapsed.forEach(sid => {{
                const body = document.getElementById('body_' + sid);
                if (body) body.classList.remove('collapsed');
            }});
            setTimeout(() => {{
                window.print();
                // Restore collapsed state
                setTimeout(() => {{
                    collapsed.forEach(sid => {{
                        const body = document.getElementById('body_' + sid);
                        if (body) body.classList.add('collapsed');
                    }});
                }}, 500);
            }}, 200);
        }}

        // ===== INIT =====
        document.addEventListener('DOMContentLoaded', () => {{
            const initSteps = [
                ['restoreCollapsedSections', () => restoreCollapsedSections()],
                ['populateMatchedTable', () => populateMatchedTable(matchedData)],
                ['populateOtherTable', () => populateOtherTable(otherData)],
                ['populateCCTable', () => populateCCTable(ccData)],
                ['populateReviewedTable', () => populateReviewedTable()],
                ['populateMovedSection', () => populateMovedSection()],
                ['populateFilterDropdowns', () => populateFilterDropdowns()],
                ['initCharts', () => initCharts()],
                ['updateReconProgress', () => updateReconProgress()]
            ];
            initSteps.forEach(([name, fn]) => {{
                try {{ fn(); }}
                catch(e) {{ console.error('Init error in ' + name + ':', e); }}
            }});
        }});
    </script>
</body>
</html>
"""

# Write HTML file
output_filename = f"reconciliation_{PERIOD_YEAR}-{PERIOD_MONTH:02d}.html"
output_path = os.path.join(OUTPUT_DIR, output_filename)
with open(output_path, 'w', encoding='utf-8') as f:
    f.write(html_content)

print(f"\nHTML report generated: {output_path}")
print(f"Total file size: {len(html_content) / 1024:.1f} KB")

# JSON status line for Node.js integration
print(json.dumps({
    "success": True,
    "outputFile": output_filename,
    "outputPath": output_path,
    "period": f"{PERIOD_YEAR}-{PERIOD_MONTH:02d}"
}))


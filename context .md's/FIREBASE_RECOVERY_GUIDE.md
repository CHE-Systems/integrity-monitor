# Firebase Hosting Code Recovery Guide

## Overview

Your Firebase Hosting deployment contains the most recent code, including the missing features. Here are several methods to recover it.

## Method 1: Download via Script (Recommended)

Run the automated script:

```bash
./retrieve_firebase_deployment.sh
```

This will:

- Download all JavaScript bundles from your Firebase site
- Download CSS files
- Check for and download source maps (if available)
- Save everything to `./firebase-deployed-code/`

Then search for your code:

```bash
# Search for Scheduling page
grep -r "SchedulingPage" firebase-deployed-code/

# Search for Issues page
grep -r "IssuesPage" firebase-deployed-code/

# Search for issues integration
grep -r "useIssueCounts" firebase-deployed-code/
grep -r "issue" firebase-deployed-code/*.js | grep -i "runs\|run.*detail"
```

## Method 2: Manual Browser Inspection

1. **Open your deployed site** in Chrome/Firefox
2. **Open DevTools** (F12)
3. **Go to Sources tab**
4. **Look for:**

   - `webpack://` or `src://` entries (if source maps are available)
   - Navigate to your source files in the file tree
   - Right-click and "Save as" to download individual files

5. **Or use Network tab:**
   - Reload the page
   - Find the main JavaScript bundle (usually `assets/index-*.js`)
   - Right-click → "Save as" to download
   - Search the downloaded file for your code

## Method 3: Direct Download via curl/wget

```bash
# Set your site URL
SITE_URL="data-integrity-monitor.web.app"  # or your actual URL

# Download index.html to see what files are referenced
curl -o index.html "https://${SITE_URL}/index.html"

# Extract and download JavaScript bundles
grep -oE 'src="[^"]*\.js[^"]*"' index.html | sed 's/src="//;s/"$//' | while read file; do
    curl -O "https://${SITE_URL}${file}"
done

# Download source maps (if available)
grep -oE 'src="[^"]*\.js[^"]*"' index.html | sed 's/src="//;s/"$//' | while read file; do
    curl -f -O "https://${SITE_URL}${file}.map" 2>/dev/null || echo "No source map for $file"
done
```

## Method 4: Use Firebase CLI (if you have access)

```bash
# List hosting releases
firebase hosting:channel:list

# Download a specific release (if you know the release ID)
# Note: This may not be directly available, but you can check:
firebase hosting:channel:list --project data-integrity-monitor
```

## Method 5: Extract from Browser Cache

If you recently visited the site:

1. **Chrome:**

   - Open DevTools → Application tab → Cache Storage
   - Look for your site's cache
   - Export/copy the JavaScript files

2. **Firefox:**
   - Open DevTools → Storage tab → Cache
   - Find your site's cached files

## What to Look For

Once you have the JavaScript bundles, search for:

### Scheduling Features:

- `SchedulingPage`
- `useFirestoreSchedules`
- `useFirestoreScheduleGroups`
- `useFirestoreScheduleExecutions`
- `schedule.*group`
- `frequency.*daily.*weekly`

### Issues Features:

- `IssuesPage`
- `IssueDetailPage`
- `useIssueCounts`
- `issue.*count`
- `issue.*detail`
- `navigate.*issue`

### Issues on RunsPage:

- `RunsPage.*issue`
- `run.*issue.*count`
- `issue.*link`
- `useIssueCounts.*run`
- Any code that links from run detail to issues

## Reconstructing Source from Bundled Code

The JavaScript will be minified/bundled, but you can:

1. **Use a beautifier:**

   ```bash
   # Install js-beautify
   npm install -g js-beautify

   # Beautify the bundle
   js-beautify firebase-deployed-code/index-*.js > beautified.js
   ```

2. **Search for function/class definitions:**

   - Look for `function SchedulingPage` or `const SchedulingPage`
   - Look for `export.*SchedulingPage`
   - Copy the entire function/component code

3. **Use source maps** (if available):
   - Source maps will map the bundled code back to original source files
   - Use a tool like `source-map-explorer` or browser DevTools

## Next Steps After Recovery

1. **Extract the code** from the bundles
2. **Compare with current code** to see what's missing
3. **Re-integrate** the missing features:
   - Issues integration on RunsPage
   - Routing in main.tsx
   - Navigation links in App.tsx
4. **Test** to ensure everything works
5. **Commit** the recovered code

## Tips

- The code will be minified, so use search to find specific features
- Look for unique strings/function names that identify your code
- Source maps are your best friend - if they exist, use them!
- The deployed code is the "truth" - it represents what was actually working

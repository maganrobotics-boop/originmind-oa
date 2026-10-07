#!/usr/bin/env python3
"""Make the current Aliyun OA home and sign-in landing page the workbench."""
from pathlib import Path
import argparse
import hashlib
import json

parser = argparse.ArgumentParser()
parser.add_argument("--oa-root", type=Path, required=True)
args = parser.parse_args()
page = args.oa_root / "app/page.tsx"
text = page.read_text()
replacements = [
    ('const [activeView, setActiveView] = useState<ViewKey>("chat");',
     'const [activeView, setActiveView] = useState<ViewKey>("project");', 1),
    ('const [primaryView, setPrimaryView] = useState<OaPrimaryView>("model");',
     'const [primaryView, setPrimaryView] = useState<OaPrimaryView>("project");', 1),
    ('else if (githubStatus === "signed-in") {\n      setActiveView("chat"); setPrimaryView("model");',
     'else if (githubStatus === "signed-in") {\n      setActiveView("project"); setPrimaryView("project");', 1),
    ('else if (feishuStatus === "signed-in") {\n      setActiveView("chat"); setPrimaryView("model");',
     'else if (feishuStatus === "signed-in") {\n      setActiveView("project"); setPrimaryView("project");', 1),
    ('useEffect(() => { if (session?.isAdmin && window.location.hash === "#future-stars") { setActiveView("future-stars"); setPrimaryView("future-stars"); } }, [session?.isAdmin]);',
     '''useEffect(() => {
    const openFutureStars = () => {
      if (session?.isAdmin && window.location.hash === "#future-stars") {
        setActiveView("future-stars"); setPrimaryView("future-stars");
      }
    };
    const followLocation = () => {
      if (!window.location.hash) { setActiveView("project"); setPrimaryView("project"); }
      else openFutureStars();
    };
    openFutureStars();
    window.addEventListener("hashchange", followLocation);
    window.addEventListener("popstate", followLocation);
    return () => {
      window.removeEventListener("hashchange", followLocation);
      window.removeEventListener("popstate", followLocation);
    };
  }, [session?.isAdmin]);''', 1),
]
changed = 0
for before, after, count in replacements:
    found = text.count(before)
    if found == 0 and text.count(after) == count:
        continue
    if found != count:
        raise RuntimeError("OA home integration anchor changed: " + before)
    text = text.replace(before, after)
    changed += count
page.write_text(text)
print(json.dumps({"changedAnchors": changed, "file": str(page),
                  "sha256": hashlib.sha256(page.read_bytes()).hexdigest()}))

#!/usr/bin/env python3
"""Check and update contractor duplicate rule similarity threshold."""

import sys
import os
import json
from datetime import datetime, timezone

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from google.cloud import firestore
from google.oauth2 import service_account

def check_and_update_rule():
    """Check the contractor duplicate rule and update similarity threshold if needed."""
    # Try to initialize Firestore client
    db = None
    try:
        # Try with service account credentials if available
        cred_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
        if cred_path:
            if not os.path.isabs(cred_path):
                backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
                cred_path = os.path.join(backend_dir, cred_path)
            if os.path.exists(cred_path):
                credentials = service_account.Credentials.from_service_account_file(cred_path)
                db = firestore.Client(credentials=credentials, project=credentials.project_id)
                print(f"✓ Initialized Firestore with service account: {cred_path}")
            else:
                print(f"⚠️  Service account file not found at {cred_path}, trying default credentials...")
                db = firestore.Client()
        else:
            db = firestore.Client()
            print("✓ Initialized Firestore with Application Default Credentials")
    except Exception as e:
        print(f"ERROR: Could not initialize Firestore client: {e}")
        print("\nMake sure you have:")
        print("  1. Google Cloud credentials configured")
        print("  2. Firestore API enabled")
        print("  3. Run: gcloud auth application-default login")
        print("  4. OR set GOOGLE_APPLICATION_CREDENTIALS environment variable")
        return
    
    if not db:
        print("ERROR: Firestore client is None")
        return
    
    collection_path = "rules/duplicates/contractors"
    docs = list(db.collection(collection_path).where("enabled", "==", True).stream())
    
    print("=" * 80)
    print("CHECKING CONTRACTOR DUPLICATE RULES")
    print("=" * 80)
    
    if not docs:
        print("No enabled contractor duplicate rules found in Firestore")
        return
    
    for doc in docs:
        data = doc.to_dict()
        rule_id = data.get("rule_id") or doc.id
        
        print(f"\nRule ID: {doc.id}")
        print(f"  rule_id field: {rule_id}")
        print(f"  description: {data.get('description', 'N/A')}")
        print(f"  enabled: {data.get('enabled', 'N/A')}")
        
        conditions = data.get("conditions", [])
        print(f"  conditions: {len(conditions)}")
        
        # Check for similarity threshold
        for i, condition in enumerate(conditions):
            print(f"\n  Condition {i+1}:")
            print(f"    type: {condition.get('type', 'N/A')}")
            print(f"    field: {condition.get('field', 'N/A')}")
            
            if condition.get("type") == "similarity":
                similarity = condition.get("similarity")
                print(f"    similarity: {similarity}")
                
                if similarity == 0.92:
                    print(f"\n  ⚠️  Found similarity threshold of 0.92 - updating to 0.8...")
                    condition["similarity"] = 0.8
                    data["conditions"][i] = condition
                    
                    # Update the document
                    doc_ref = db.collection(collection_path).document(doc.id)
                    doc_ref.update({"conditions": data["conditions"]})
                    print(f"  ✅ Updated similarity threshold to 0.8")
                elif similarity == 0.8:
                    print(f"  ✅ Similarity threshold is already 0.8")
                else:
                    print(f"  ℹ️  Similarity threshold is {similarity} (not 0.92, leaving unchanged)")
    
    print("\n" + "=" * 80)
    print("Done!")

if __name__ == "__main__":
    check_and_update_rule()


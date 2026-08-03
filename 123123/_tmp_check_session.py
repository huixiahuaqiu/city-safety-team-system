import sys
sys.path.insert(0, "/opt/citysafe/123123")
import data_store
for a in data_store.load_accounts():
    if str(a.get("studentId") or "").lower() in ("admin", "luowenwen326", "jluo"):
        print(a.get("realName"), "sid=", a.get("studentId"),
              "pwu=", a.get("passwordUpdatedAt"),
              "sv=", a.get("sessionVersion"),
              "mustChange=", a.get("mustChangePwd"),
              "status=", a.get("status"),
              "role=", a.get("role"))

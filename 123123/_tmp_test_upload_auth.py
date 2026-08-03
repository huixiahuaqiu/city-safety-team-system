import json, ssl, urllib.request, http.client, mimetypes, uuid

ctx = ssl._create_unverified_context()

def login():
    body = json.dumps({"username": "admin", "password": "TeamAdmin2026b"}).encode()
    req = urllib.request.Request(
        "https://127.0.0.1/api/auth/login",
        data=body,
        headers={"Content-Type": "application/json", "Host": "cqust-citysafe.online"},
        method="POST",
    )
    with urllib.request.urlopen(req, context=ctx, timeout=20) as resp:
        return json.loads(resp.read().decode())

def multipart_upload(token):
    boundary = "----citysafe" + uuid.uuid4().hex
    file_content = b"\xff\xd8\xff\xd9"  # minimal jpeg-ish
    parts = []
    for name, value in (("fileName", "avatar-test.jpg"), ("fileType", "other"), ("remark", "avatar-test")):
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode())
    parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"avatar-test.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n".encode()
        + file_content
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)
    req = urllib.request.Request(
        "https://127.0.0.1/api/shared-file/upload",
        data=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Host": "cqust-citysafe.online",
            "Authorization": "Bearer " + token,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

data = login()
print("login", bool(data.get("token")), data.get("user", {}).get("role"), "mustChange", data.get("user", {}).get("mustChangePwd"))
code, text = multipart_upload(data["token"])
print("upload", code, text[:300])

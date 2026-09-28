# -*- coding: utf-8 -*-
"""
Recesso — controle de férias e ausências (versão standalone Flask + SQLite).

Como rodar:
    pip install -r requirements.txt
    python app.py

Por padrão o servidor sobe em http://0.0.0.0:8080 (acessível pela rede
interna pelo IP do computador). Para mudar a porta, defina a variável de
ambiente PORT antes de rodar, por exemplo:
    set PORT=9000
    python app.py

Veja o arquivo LEIA-ME.txt para instruções completas em português.
"""

import csv
import io
import os
import re
import secrets
import sqlite3
import sys
from datetime import datetime, date
from functools import wraps

from flask import Flask, Response, g, jsonify, render_template, request, session

# Quando o app.exe é gerado com --noconsole/--windowed (sem janela preta),
# o Windows não dá ao programa nenhum stdout/stderr de verdade — eles ficam
# como None. Sem isso, o primeiro "print(...)" ou qualquer log do Flask
# quebra o programa na hora com "AttributeError: 'NoneType' object has no
# attribute 'write'" (erro clássico de app empacotado sem console). Aqui a
# gente troca por um "buraco negro" pra esses prints não derrubarem o app.
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def resource_path(relative_path):
    """Caminho pra arquivos empacotados (templates/static). Quando o programa
    roda como script normal, é a mesma pasta de sempre; quando roda empacotado
    como app.exe (PyInstaller, modo --onefile), os arquivos ficam extraídos
    numa pasta temporária apontada por sys._MEIPASS — sem isso o app.exe não
    acha o HTML/CSS/JS e quebra ao abrir."""
    base = getattr(sys, "_MEIPASS", BASE_DIR)
    return os.path.join(base, relative_path)


def persistent_dir():
    """Pasta onde ficam o banco de dados (recesso.db) e a chave de sessão
    (secret.key) — sempre ao LADO do programa (do app.exe ou do app.py), nunca
    dentro da pasta temporária do PyInstaller (que é apagada quando o programa
    fecha, o que faria perder os dados cadastrados a cada reinício)."""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return BASE_DIR


DB_PATH = os.path.join(persistent_dir(), "recesso.db")
SECRET_KEY_PATH = os.path.join(persistent_dir(), "secret.key")

DEFAULT_ANNUAL_DAYS = 30
LEAVE_TYPES = ("ferias", "folga", "atestado", "falta")

# ----------------------------------------------------------------------
# App / secret key
# ----------------------------------------------------------------------


def get_or_create_secret_key():
    """Keeps sessions valid across restarts, unique per installation."""
    try:
        if os.path.exists(SECRET_KEY_PATH):
            with open(SECRET_KEY_PATH, "r", encoding="utf-8") as f:
                key = f.read().strip()
                if key:
                    return key
    except OSError:
        pass
    key = secrets.token_hex(32)
    try:
        with open(SECRET_KEY_PATH, "w", encoding="utf-8") as f:
            f.write(key)
    except OSError:
        pass
    return key


app = Flask(
    __name__,
    template_folder=resource_path("templates"),
    static_folder=resource_path("static"),
)
app.config["SECRET_KEY"] = get_or_create_secret_key()
app.config["JSON_AS_ASCII"] = False
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"


# ----------------------------------------------------------------------
# Database
# ----------------------------------------------------------------------


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS users(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            username_key TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS employees(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            role TEXT,
            department TEXT,
            admission_date TEXT,
            annual_days INTEGER NOT NULL DEFAULT 30,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS leave_records(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_id INTEGER NOT NULL,
            employee_name TEXT NOT NULL,
            type TEXT NOT NULL,
            start_date TEXT NOT NULL,
            end_date TEXT NOT NULL,
            reason TEXT,
            created_at TEXT NOT NULL,
            created_by TEXT
        );
        """
    )
    db.commit()
    db.close()


init_db()


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def today_iso():
    return date.today().isoformat()


DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def is_valid_date(s):
    return bool(s) and bool(DATE_RE.match(s))


def row_to_user(row, include_self=None):
    return {
        "id": str(row["id"]),
        "username": row["username"],
        "usernameKey": row["username_key"],
        "role": row["role"],
        "createdAt": row["created_at"],
    }


def row_to_employee(row):
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "role": row["role"] or "",
        "department": row["department"] or "",
        "admissionDate": row["admission_date"] or "",
        "annualDays": row["annual_days"] if row["annual_days"] is not None else DEFAULT_ANNUAL_DAYS,
        "active": bool(row["active"]),
        "createdAt": row["created_at"],
    }


def row_to_leave(row):
    return {
        "id": str(row["id"]),
        "employeeId": str(row["employee_id"]),
        "employeeName": row["employee_name"],
        "type": row["type"],
        "startDate": row["start_date"],
        "endDate": row["end_date"],
        "reason": row["reason"] or "",
        "createdAt": row["created_at"],
        "createdBy": row["created_by"] or "",
    }


def current_user_row():
    uid = session.get("user_id")
    if not uid:
        return None
    db = get_db()
    return db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()


def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not current_user_row():
            return jsonify({"error": "unauthorized", "message": "Sessão expirada. Entre novamente."}), 401
        return f(*args, **kwargs)

    return wrapper


def admin_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        user = current_user_row()
        if not user:
            return jsonify({"error": "unauthorized", "message": "Sessão expirada. Entre novamente."}), 401
        if user["role"] != "admin":
            return jsonify({"error": "forbidden", "message": "Apenas administradores podem fazer isso."}), 403
        return f(*args, **kwargs)

    return wrapper


# ----------------------------------------------------------------------
# Page route
# ----------------------------------------------------------------------


@app.route("/")
def index():
    return render_template("index.html")


# ----------------------------------------------------------------------
# Auth API
# ----------------------------------------------------------------------


@app.route("/api/bootstrap")
def api_bootstrap():
    db = get_db()
    has_users = db.execute("SELECT 1 FROM users LIMIT 1").fetchone() is not None
    user = current_user_row()
    return jsonify(
        {
            "needsSetup": not has_users,
            "user": row_to_user(user) if user else None,
        }
    )


@app.route("/api/setup", methods=["POST"])
def api_setup():
    db = get_db()
    has_users = db.execute("SELECT 1 FROM users LIMIT 1").fetchone() is not None
    if has_users:
        return jsonify({"error": "already_setup", "message": "Já existe um administrador cadastrado."}), 400

    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    password2 = data.get("password2") or ""

    if not username:
        return jsonify({"error": "invalid", "message": "Informe um usuário."}), 400
    if len(password) < 6:
        return jsonify({"error": "invalid", "message": "A senha precisa ter pelo menos 6 caracteres."}), 400
    if password != password2:
        return jsonify({"error": "invalid", "message": "As senhas não conferem."}), 400

    from werkzeug.security import generate_password_hash

    username_key = username.lower()
    cur = db.execute(
        "INSERT INTO users(username, username_key, password_hash, role, created_at) VALUES (?,?,?,?,?)",
        (username, username_key, generate_password_hash(password), "admin", now_iso()),
    )
    db.commit()
    user_row = db.execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone()
    session.clear()
    session["user_id"] = user_row["id"]
    session.permanent = True
    return jsonify({"user": row_to_user(user_row)})


@app.route("/api/login", methods=["POST"])
def api_login():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip().lower()
    password = data.get("password") or ""
    if not username or not password:
        return jsonify({"error": "invalid", "message": "Informe usuário e senha."}), 400

    from werkzeug.security import check_password_hash

    db = get_db()
    row = db.execute("SELECT * FROM users WHERE username_key=?", (username,)).fetchone()
    if not row or not check_password_hash(row["password_hash"], password):
        return jsonify({"error": "bad_login", "message": "Usuário ou senha incorretos."}), 401

    session.clear()
    session["user_id"] = row["id"]
    session.permanent = True
    return jsonify({"user": row_to_user(row)})


@app.route("/api/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify({"ok": True})


# ----------------------------------------------------------------------
# Employees API
# ----------------------------------------------------------------------


@app.route("/api/employees", methods=["GET"])
@login_required
def api_employees_list():
    db = get_db()
    rows = db.execute("SELECT * FROM employees ORDER BY name COLLATE NOCASE").fetchall()
    return jsonify({"employees": [row_to_employee(r) for r in rows]})


@app.route("/api/employees", methods=["POST"])
@login_required
def api_employees_create():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "invalid", "message": "Informe o nome do funcionário."}), 400
    try:
        annual_days = int(data.get("annualDays") or 0)
    except (TypeError, ValueError):
        annual_days = 0
    admission_date = (data.get("admissionDate") or "").strip()
    if admission_date and not is_valid_date(admission_date):
        return jsonify({"error": "invalid", "message": "Data de admissão inválida."}), 400

    db = get_db()
    cur = db.execute(
        "INSERT INTO employees(name, role, department, admission_date, annual_days, active, created_at) "
        "VALUES (?,?,?,?,?,?,?)",
        (
            name,
            (data.get("role") or "").strip(),
            (data.get("department") or "").strip(),
            admission_date,
            annual_days,
            1 if data.get("active", True) else 0,
            now_iso(),
        ),
    )
    db.commit()
    row = db.execute("SELECT * FROM employees WHERE id=?", (cur.lastrowid,)).fetchone()
    return jsonify({"employee": row_to_employee(row)})


@app.route("/api/employees/<int:emp_id>", methods=["PUT"])
@login_required
def api_employees_update(emp_id):
    db = get_db()
    existing = db.execute("SELECT * FROM employees WHERE id=?", (emp_id,)).fetchone()
    if not existing:
        return jsonify({"error": "not_found", "message": "Funcionário não encontrado."}), 404

    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "invalid", "message": "Informe o nome do funcionário."}), 400
    try:
        annual_days = int(data.get("annualDays") or 0)
    except (TypeError, ValueError):
        annual_days = 0
    admission_date = (data.get("admissionDate") or "").strip()
    if admission_date and not is_valid_date(admission_date):
        return jsonify({"error": "invalid", "message": "Data de admissão inválida."}), 400

    db.execute(
        "UPDATE employees SET name=?, role=?, department=?, admission_date=?, annual_days=?, active=? WHERE id=?",
        (
            name,
            (data.get("role") or "").strip(),
            (data.get("department") or "").strip(),
            admission_date,
            annual_days,
            1 if data.get("active", True) else 0,
            emp_id,
        ),
    )
    db.commit()
    row = db.execute("SELECT * FROM employees WHERE id=?", (emp_id,)).fetchone()
    return jsonify({"employee": row_to_employee(row)})


@app.route("/api/employees/<int:emp_id>", methods=["DELETE"])
@login_required
def api_employees_delete(emp_id):
    db = get_db()
    db.execute("DELETE FROM employees WHERE id=?", (emp_id,))
    db.commit()
    return jsonify({"ok": True})


# ----------------------------------------------------------------------
# Leave records API
# ----------------------------------------------------------------------


@app.route("/api/leaves", methods=["GET"])
@login_required
def api_leaves_list():
    db = get_db()
    rows = db.execute("SELECT * FROM leave_records ORDER BY start_date DESC").fetchall()
    return jsonify({"leaves": [row_to_leave(r) for r in rows]})


def validate_leave_payload(data):
    employee_id = data.get("employeeId")
    if not employee_id:
        return None, ("invalid", "Selecione o funcionário.")
    try:
        employee_id = int(employee_id)
    except (TypeError, ValueError):
        return None, ("invalid", "Funcionário inválido.")

    leave_type = data.get("type") or "ferias"
    if leave_type not in LEAVE_TYPES:
        return None, ("invalid", "Tipo de ausência inválido.")

    start = (data.get("startDate") or "").strip()
    end = (data.get("endDate") or start).strip()
    if not is_valid_date(start):
        return None, ("invalid", "Informe a data.")
    if not is_valid_date(end):
        end = start
    if end < start:
        return None, ("invalid", "A data final não pode ser antes da inicial.")

    return {
        "employee_id": employee_id,
        "type": leave_type,
        "start_date": start,
        "end_date": end,
        "reason": (data.get("reason") or "").strip(),
    }, None


@app.route("/api/leaves", methods=["POST"])
@login_required
def api_leaves_create():
    data = request.get_json(silent=True) or {}
    payload, err = validate_leave_payload(data)
    if err:
        return jsonify({"error": err[0], "message": err[1]}), 400

    db = get_db()
    emp = db.execute("SELECT * FROM employees WHERE id=?", (payload["employee_id"],)).fetchone()
    if not emp:
        return jsonify({"error": "invalid", "message": "Funcionário não encontrado."}), 400

    user = current_user_row()
    cur = db.execute(
        "INSERT INTO leave_records(employee_id, employee_name, type, start_date, end_date, reason, created_at, created_by) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (
            payload["employee_id"],
            emp["name"],
            payload["type"],
            payload["start_date"],
            payload["end_date"],
            payload["reason"],
            now_iso(),
            user["username"] if user else "",
        ),
    )
    db.commit()
    row = db.execute("SELECT * FROM leave_records WHERE id=?", (cur.lastrowid,)).fetchone()
    return jsonify({"leave": row_to_leave(row)})


@app.route("/api/leaves/<int:leave_id>", methods=["PUT"])
@login_required
def api_leaves_update(leave_id):
    db = get_db()
    existing = db.execute("SELECT * FROM leave_records WHERE id=?", (leave_id,)).fetchone()
    if not existing:
        return jsonify({"error": "not_found", "message": "Registro não encontrado."}), 404

    data = request.get_json(silent=True) or {}
    payload, err = validate_leave_payload(data)
    if err:
        return jsonify({"error": err[0], "message": err[1]}), 400

    emp = db.execute("SELECT * FROM employees WHERE id=?", (payload["employee_id"],)).fetchone()
    if not emp:
        return jsonify({"error": "invalid", "message": "Funcionário não encontrado."}), 400

    db.execute(
        "UPDATE leave_records SET employee_id=?, employee_name=?, type=?, start_date=?, end_date=?, reason=? WHERE id=?",
        (
            payload["employee_id"],
            emp["name"],
            payload["type"],
            payload["start_date"],
            payload["end_date"],
            payload["reason"],
            leave_id,
        ),
    )
    db.commit()
    row = db.execute("SELECT * FROM leave_records WHERE id=?", (leave_id,)).fetchone()
    return jsonify({"leave": row_to_leave(row)})


@app.route("/api/leaves/<int:leave_id>", methods=["DELETE"])
@login_required
def api_leaves_delete(leave_id):
    db = get_db()
    db.execute("DELETE FROM leave_records WHERE id=?", (leave_id,))
    db.commit()
    return jsonify({"ok": True})


TYPE_LABEL = {"ferias": "Ferias", "folga": "Folga", "atestado": "Atestado", "falta": "Falta"}

MESES_PT = [
    "janeiro", "fevereiro", "março", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
]

NUMEROS_PT = {
    1: "um", 2: "dois", 3: "três", 4: "quatro", 5: "cinco",
    6: "seis", 7: "sete", 8: "oito", 9: "nove", 10: "dez",
    11: "onze", 12: "doze", 13: "treze", 14: "catorze", 15: "quinze",
    16: "dezesseis", 17: "dezessete", 18: "dezoito", 19: "dezenove", 20: "vinte",
    21: "vinte e um", 22: "vinte e dois", 23: "vinte e três", 24: "vinte e quatro",
    25: "vinte e cinco", 26: "vinte e seis", 27: "vinte e sete", 28: "vinte e oito",
    29: "vinte e nove", 30: "trinta", 31: "trinta e um",
}


def data_por_extenso(iso_date):
    d = date.fromisoformat(iso_date)
    return "%d de %s de %d" % (d.day, MESES_PT[d.month - 1], d.year)


def numero_por_extenso(n):
    return NUMEROS_PT.get(n, str(n))


# Cidade usada no cabeçalho da autorização de desconto de férias. Fixo por
# enquanto — se precisar mudar pra outra cidade, é só editar essa linha.
CIDADE_AUTORIZACAO = "São Paulo"


@app.route("/leaves/<int:leave_id>/autorizacao")
@login_required
def leave_authorization(leave_id):
    db = get_db()
    row = db.execute("SELECT * FROM leave_records WHERE id=?", (leave_id,)).fetchone()
    if not row:
        return "Registro de ausência não encontrado.", 404

    leave = row_to_leave(row)
    start = date.fromisoformat(leave["startDate"])
    end = date.fromisoformat(leave["endDate"])
    dias = (end - start).days + 1

    if leave["startDate"] == leave["endDate"]:
        periodo_texto = "ao dia %s" % data_por_extenso(leave["startDate"])
    else:
        periodo_texto = "aos dias %s a %s" % (
            data_por_extenso(leave["startDate"]),
            data_por_extenso(leave["endDate"]),
        )

    return render_template(
        "autorizacao.html",
        employee_name=leave["employeeName"],
        dias_num=dias,
        dias_extenso=numero_por_extenso(dias),
        dia_plural="dia" if dias == 1 else "dias",
        periodo_texto=periodo_texto,
        hoje_extenso=data_por_extenso(today_iso()),
        cidade=CIDADE_AUTORIZACAO,
    )


@app.route("/api/leaves/export")
@login_required
def api_leaves_export():
    db = get_db()
    month = request.args.get("month", type=int)
    year = request.args.get("year", type=int)
    employee_id = request.args.get("employeeId", default="", type=str)
    leave_type = request.args.get("type", default="", type=str)

    rows = db.execute("SELECT * FROM leave_records ORDER BY start_date ASC").fetchall()

    def overlaps_month(r):
        if not month or not year:
            return True
        month_start = "%04d-%02d-01" % (year, month)
        # last day of month
        if month == 12:
            next_month_first = "%04d-01-01" % (year + 1)
        else:
            next_month_first = "%04d-%02d-01" % (year, month + 1)
        return r["start_date"] < next_month_first and r["end_date"] >= month_start

    filtered = []
    for r in rows:
        if employee_id and str(r["employee_id"]) != str(employee_id):
            continue
        if leave_type and r["type"] != leave_type:
            continue
        if not overlaps_month(r):
            continue
        filtered.append(r)

    output = io.StringIO()
    output.write("﻿")
    writer = csv.writer(output, delimiter=";", lineterminator="\r\n")
    writer.writerow(["Funcionario", "Tipo", "Inicio", "Fim", "Dias", "Motivo", "Criado por"])
    for r in filtered:
        start = date.fromisoformat(r["start_date"])
        end = date.fromisoformat(r["end_date"])
        days = (end - start).days + 1
        writer.writerow(
            [
                r["employee_name"],
                TYPE_LABEL.get(r["type"], r["type"]),
                r["start_date"],
                r["end_date"],
                days,
                re.sub(r"\s+", " ", r["reason"] or ""),
                r["created_by"] or "",
            ]
        )

    filename = "recesso-ausencias-%04d-%02d.csv" % (year or date.today().year, month or date.today().month)
    resp = Response(output.getvalue(), content_type="text/csv; charset=utf-8")
    resp.headers["Content-Disposition"] = "attachment; filename=%s" % filename
    return resp


# ----------------------------------------------------------------------
# Users API (admin only)
# ----------------------------------------------------------------------


@app.route("/api/users", methods=["GET"])
@admin_required
def api_users_list():
    db = get_db()
    rows = db.execute("SELECT * FROM users ORDER BY username COLLATE NOCASE").fetchall()
    return jsonify({"users": [row_to_user(r) for r in rows]})


@app.route("/api/users", methods=["POST"])
@admin_required
def api_users_create():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    role = data.get("role") or "user"
    if role not in ("admin", "user"):
        role = "user"
    if not username:
        return jsonify({"error": "invalid", "message": "Informe um usuário."}), 400
    if len(password) < 6:
        return jsonify({"error": "invalid", "message": "A senha precisa ter pelo menos 6 caracteres."}), 400

    db = get_db()
    username_key = username.lower()
    exists = db.execute("SELECT 1 FROM users WHERE username_key=?", (username_key,)).fetchone()
    if exists:
        return jsonify({"error": "invalid", "message": "Já existe um usuário com esse nome."}), 400

    from werkzeug.security import generate_password_hash

    cur = db.execute(
        "INSERT INTO users(username, username_key, password_hash, role, created_at) VALUES (?,?,?,?,?)",
        (username, username_key, generate_password_hash(password), role, now_iso()),
    )
    db.commit()
    row = db.execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone()
    return jsonify({"user": row_to_user(row)})


@app.route("/api/users/<int:user_id>", methods=["DELETE"])
@admin_required
def api_users_delete(user_id):
    db = get_db()
    me = current_user_row()
    if me and me["id"] == user_id:
        return jsonify({"error": "invalid", "message": "Você não pode excluir seu próprio usuário."}), 400

    target = db.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    if not target:
        return jsonify({"error": "not_found", "message": "Usuário não encontrado."}), 404

    if target["role"] == "admin":
        admin_count = db.execute("SELECT COUNT(*) AS c FROM users WHERE role='admin'").fetchone()["c"]
        if admin_count <= 1:
            return jsonify({"error": "invalid", "message": "Não é possível excluir o único administrador."}), 400

    db.execute("DELETE FROM users WHERE id=?", (user_id,))
    db.commit()
    return jsonify({"ok": True})


# ----------------------------------------------------------------------
# Entry point
# ----------------------------------------------------------------------

def abrir_navegador_depois(port, delay=1.2):
    """Abre o navegador sozinho em http://127.0.0.1:porta assim que o
    servidor estiver pronto — mesmo comportamento do banco_horas.exe. Roda
    numa thread separada com um pequeno atraso pra dar tempo do Flask
    terminar de subir antes do navegador tentar acessar."""
    import threading
    import webbrowser

    def _abrir():
        webbrowser.open("http://127.0.0.1:%d" % port)

    threading.Timer(delay, _abrir).start()


def ja_esta_rodando(port):
    """Testa se já existe um Recesso rodando nessa porta, tentando ocupar a
    porta antes do Flask. Como o app.exe (--noconsole) não mostra nenhuma
    janela, é fácil a pessoa clicar duas vezes achando que não abriu — isso
    criava vários processos disputando a mesma porta ao mesmo tempo. Se a
    porta já estiver ocupada por um Recesso anterior, a gente não sobe um
    servidor novo: só abre o navegador de novo no que já está rodando."""
    import socket

    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("0.0.0.0", port))
        s.close()
        return False
    except OSError:
        return True


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))

    if ja_esta_rodando(port):
        # Já tem um Recesso rodando nessa porta (provavelmente clicou no
        # app.exe mais de uma vez) — não inicia outro servidor, só abre o
        # navegador de novo no que já está no ar.
        if os.environ.get("RECESSO_NO_BROWSER") != "1":
            abrir_navegador_depois(port, delay=0.1)
        sys.exit(0)

    print("=" * 60)
    print("Recesso rodando! Acesse pela rede interna em:")
    print("  http://SEU-IP-AQUI:%d" % port)
    print("(troque SEU-IP-AQUI pelo IP deste computador na rede)")
    print("Para parar o servidor, feche esta janela ou aperte Ctrl+C.")
    print("=" * 60)
    if os.environ.get("RECESSO_NO_BROWSER") != "1":
        abrir_navegador_depois(port)
    app.run(host="0.0.0.0", port=port, debug=False)

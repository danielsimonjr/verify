"""Runs wb.py's _free_port() with a socket module that records the address it binds.

wb.py cannot be imported here: its host-side half imports the retired Python `harness` package.
The probe therefore parses the file, takes the one function, and runs it in a small namespace.

usage: python free_port_probe.py <path to wb.py>
prints one JSON object: {"bound": [<host>, <port>...], "port": <int>}
"""

import ast
import json
import socket as real_socket
import sys
import types

source = open(sys.argv[1], encoding="utf-8").read()
fn = next(
    n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == "_free_port"
)
module = ast.Module(body=[fn], type_ignores=[])

bound = []


class RecordingSocket(real_socket.socket):
    def bind(self, address):
        bound.append(list(address))
        return super().bind(address)


fake = types.SimpleNamespace(socket=RecordingSocket)
ns = {"socket": fake}
exec(compile(module, sys.argv[1], "exec"), ns)
port = ns["_free_port"]()
print(json.dumps({"bound": bound, "port": port}))

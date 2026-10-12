#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本地测试用静态服务器。

在项目根目录起一个 http.server，另外把 /winfont/<file> 映射到
C:\\Windows\\Fonts\\<file>，便于「用本机字体自造 FRB2 特征表」的
字体解密回归测试（fixture-font.html）拿到一份真实字体文件。

用法（在项目根目录）：
    python test/serve.py 8792
"""
import os
import sys
import http.server
import socketserver
from urllib.parse import unquote, urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT_DIR = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
FONT_PREFIX = "/winfont/"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def translate_path(self, path):
        clean = unquote(urlparse(path).path)
        if clean.startswith(FONT_PREFIX):
            name = os.path.basename(clean[len(FONT_PREFIX):])
            return os.path.join(FONT_DIR, name)
        return super().translate_path(path)

    def end_headers(self):
        # 便于本地调试：允许任意来源读取（仅本机回环）
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    # 支持 port=0：让系统分配一个空闲端口，避免固定端口被上一次残留占用
    # （曾经出现「端口被占 → 新服务起不来 → 旧服务在服务请求」的假象）
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8792
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", port), Handler) as httpd:
        real = httpd.server_address[1]
        print("PORT=%d" % real, flush=True)      # 供 run-fixtures.sh 读取实际端口
        print("serving %s at http://127.0.0.1:%d/  (fonts at %s)" % (ROOT, real, FONT_PREFIX), flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()

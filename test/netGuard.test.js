const test = require("node:test");
const assert = require("node:assert/strict");
const { isPrivateAddress, assertPublicUrl, safeFetch, BlockedUrlError } = require("../lib/netGuard");

test("alamat internal dikenali", () => {
  for (const ip of [
    "127.0.0.1",
    "127.10.0.5",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "64:ff9b::a9fe:a9fe"
  ]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
});

test("alamat publik lolos", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("assertPublicUrl menolak skema dan host lokal", async () => {
  await assert.rejects(assertPublicUrl("file:///etc/passwd"), BlockedUrlError);
  await assert.rejects(assertPublicUrl("ftp://example.com"), BlockedUrlError);
  await assert.rejects(assertPublicUrl("http://localhost:3000"), BlockedUrlError);
  await assert.rejects(assertPublicUrl("http://foo.localhost/"), BlockedUrlError);
  await assert.rejects(assertPublicUrl("http://127.0.0.1:42235/json"), BlockedUrlError);
  await assert.rejects(assertPublicUrl("http://[::1]/"), BlockedUrlError);
  await assert.rejects(assertPublicUrl("bukan url"), BlockedUrlError);
});

test("assertPublicUrl memeriksa hasil DNS", async () => {
  const lookup = async (host) =>
    host === "internal.example" ? [{ address: "10.0.0.5" }] : [{ address: "93.184.216.34" }];
  await assert.rejects(assertPublicUrl("https://internal.example/", { lookup }), /10\.0\.0\.5/);
  const url = await assertPublicUrl("https://public.example/path", { lookup });
  assert.equal(url.hostname, "public.example");
});

test("safeFetch memeriksa ulang tujuan redirect", async () => {
  const realFetch = global.fetch;
  const lookup = async () => [{ address: "93.184.216.34" }];
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, redirect: opts.redirect });
    return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
  };
  try {
    await assert.rejects(safeFetch("https://public.example/", {}, { lookup }), /169\.254\.169\.254/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].redirect, "manual");
  } finally {
    global.fetch = realFetch;
  }
});

test("safeFetch mengikuti redirect publik dan mengubah POST jadi GET pada 303", async () => {
  const realFetch = global.fetch;
  const lookup = async () => [{ address: "93.184.216.34" }];
  const seen = [];
  global.fetch = async (url, opts) => {
    seen.push([url, opts.method, opts.body]);
    if (seen.length === 1) return new Response(null, { status: 303, headers: { location: "/done" } });
    return new Response("ok", { status: 200 });
  };
  try {
    const res = await safeFetch("https://public.example/form", { method: "POST", body: "x=1" }, { lookup });
    assert.equal(await res.text(), "ok");
    assert.deepEqual(seen[1], ["https://public.example/done", "GET", undefined]);
  } finally {
    global.fetch = realFetch;
  }
});

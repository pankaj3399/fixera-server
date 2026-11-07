import { describe, expect, it } from 'vitest';
import { isLocalMongoTestUri } from '../localMongoUri';

describe('local MongoDB fixture guard', () => {
  it.each(['mongodb://localhost/test', 'mongodb://127.0.0.1:27032/db?replicaSet=cr248',
    'mongodb://user:p%40ss@localhost:27017/test', 'mongodb://[::1]:27017/test',
    'mongodb://user:pass@[::1]/test'])('accepts explicit loopback URI %s', uri => {
    expect(isLocalMongoTestUri(uri)).toBe(true);
  });
  it.each([undefined, '', 'not a test URI', 'https://localhost/test',
    'mongodb+srv://test.cluster.mongodb.net/test', 'mongodb://test.cluster.mongodb.net/test',
    'mongodb://localhost.evil.example/test', 'mongodb://localhost@remote.example/test',
    'mongodb://remote.example/?appName=localhost-test', 'mongodb://127.0.0.1,remote.example/test',
    'mongodb://[2001:db8::1]:27017/test'])('rejects nonlocal or invalid URI %s', uri => {
    expect(isLocalMongoTestUri(uri)).toBe(false);
  });
});

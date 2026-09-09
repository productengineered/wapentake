import test from 'node:test';
import assert from 'node:assert/strict';
import { assess, disposition } from '../.github/scripts/review-gate.mjs';

const complete={context:'CodeRabbit',state:'success',description:'Review completed',creator:{login:'coderabbitai[bot]'}};
const original={body:'Please handle this failure.',authorAssociation:'NONE',author:{login:'coderabbitai[bot]'}};
const fixed={body:'Fixed: abc1234 — Refuse missing metadata before publishing a successful check.',authorAssociation:'OWNER',author:{login:'maintainer'}};

test('review gate rejects green skipped, stale, pending and impersonated CodeRabbit results',()=>{
  assert.deepEqual(assess([complete],[]),[]);
  for(const statuses of [[],[{...complete,description:'Review skipped: bot user not eligible for review'}],[{...complete,state:'pending'},complete],[{...complete,creator:{login:'someone-else'}}]])assert.ok(assess(statuses,[]).length);
});

test('review gate requires resolution plus a substantive collaborator disposition on every thread',()=>{
  const thread={id:'thread',isResolved:true,comments:[original,fixed]};
  assert.deepEqual(assess([complete],[thread]),[]);
  assert.ok(assess([complete],[{...thread,isResolved:false}]).length);
  assert.ok(assess([complete],[{...thread,comments:[original]}]).length);
  assert.equal(disposition([original,{...fixed,authorAssociation:'CONTRIBUTOR'}]),undefined);
  assert.equal(disposition([original,{...fixed,body:'Fixed: abc1234 done'}]),undefined);
  assert.equal(disposition([original,{...fixed,author:{login:'coderabbitai[bot]'}}]),undefined);
});

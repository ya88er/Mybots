import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventMapper } from '../../src/runtime/event-mapper.ts';

// The engine reads exactly these discriminants (miniapp/node/miniapp-api.ts),
// and it reconciles a committed message against the streamed tail. The mapper
// is the only producer, so it is where the invariants belong.
//
// These tests use a fake Pi event source: they pin the translation, not Pi.

function collect() {
  const events = [];
  return { events, emit: (event) => events.push(event) };
}

/** A Pi message with visible text blocks. */
function assistantMessage(text) {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

test('a turn emits exactly one turn.started', () => {
  const { events, emit } = collect();
  const mapper = new EventMapper({ sessionId: 's1', turnId: 't1', emit });

  mapper.handle({ type: 'turn_start' });
  mapper.handle({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', delta: 'hi' } });
  mapper.handle({ type: 'turn_end', message: assistantMessage('hi'), toolResults: [] });

  assert.equal(events.filter((e) => e.type === 'turn.started').length, 1);
});

test('text deltas stream and the message is committed once', () => {
  const { events, emit } = collect();
  const mapper = new EventMapper({ sessionId: 's1', turnId: 't1', emit });

  mapper.handle({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', delta: 'Hel' } });
  mapper.handle({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', delta: 'lo' } });
  mapper.handle({ type: 'message_end', message: assistantMessage('Hello') });

  const deltas = events.filter((e) => e.type === 'text.delta');
  assert.equal(deltas.length, 2);
  assert.equal(deltas.map((d) => d.text).join(''), 'Hello');

  const commits = events.filter((e) => e.type === 'message.committed');
  assert.equal(commits.length, 1);
  assert.equal(commits[0].text, 'Hello');
});

test('several assistant messages in one run commit separately', () => {
  const { events, emit } = collect();
  const mapper = new EventMapper({ sessionId: 's1', turnId: 't1', emit });

  mapper.handle({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', delta: 'first' } });
  mapper.handle({ type: 'message_end', message: assistantMessage('first') });
  mapper.handle({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', delta: 'second' } });
  mapper.handle({ type: 'message_end', message: assistantMessage('second') });

  const commits = events.filter((e) => e.type === 'message.committed');
  assert.equal(commits.length, 2);
  assert.equal(commits[0].text, 'first');
  assert.equal(commits[1].text, 'second');
});

test('reasoning blocks are not treated as visible answer text', () => {
  const { events, emit } = collect();
  const mapper = new EventMapper({ sessionId: 's1', turnId: 't1', emit });

  mapper.handle({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'internal reasoning' },
        { type: 'text', text: 'the answer' },
      ],
    },
  });

  const commits = events.filter((e) => e.type === 'message.committed');
  assert.equal(commits.length, 1);
  assert.equal(commits[0].text, 'the answer');
  assert.ok(!JSON.stringify(commits[0]).includes('internal reasoning'));
});

test('two concurrent calls to the same tool are distinguishable by call id', () => {
  const { events, emit } = collect();
  const mapper = new EventMapper({ sessionId: 's1', turnId: 't1', emit });

  mapper.handle({ type: 'tool_execution_start', toolCallId: 'call_a', toolName: 'read_file', args: {} });
  mapper.handle({ type: 'tool_execution_start', toolCallId: 'call_b', toolName: 'read_file', args: {} });
  mapper.handle({ type: 'tool_execution_end', toolCallId: 'call_b', toolName: 'read_file', result: {}, isError: false });
  mapper.handle({ type: 'tool_execution_end', toolCallId: 'call_a', toolName: 'read_file', result: {}, isError: true });

  const started = events.filter((e) => e.type === 'tool.started');
  const finished = events.filter((e) => e.type === 'tool.finished');
  assert.equal(started.length, 2);
  assert.equal(finished.length, 2);
  // The failing call is the one that reports ok:false.
  const failed = finished.filter((e) => e.ok === false);
  assert.equal(failed.length, 1);
});

test('a run finishes exactly once', () => {
  const { events, emit } = collect();
  const mapper = new EventMapper({ sessionId: 's1', turnId: 't1', emit });

  mapper.finish('finished', 'done');
  mapper.finish('error', undefined, { code: 'X', message: 'y' });

  const terminal = events.filter((e) => e.type === 'turn.finished');
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].status, 'finished');
  assert.equal(terminal[0].text, 'done');
});

test('a turn that never reported a start still finishes with one started event', () => {
  const { events, emit } = collect();
  const mapper = new EventMapper({ sessionId: 's1', turnId: 't1', emit });

  mapper.finish('finished', 'ok');

  const order = events.map((e) => e.type);
  assert.deepEqual(order, ['turn.started', 'turn.finished']);
});

test('a tool marks the turn as having side effects', () => {
  const { events, emit } = collect();
  const mapper = new EventMapper({ sessionId: 's1', turnId: 't1', emit });

  assert.equal(mapper.toolStarted, false);
  mapper.handle({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'write_file', args: {} });
  assert.equal(mapper.toolStarted, true);
});

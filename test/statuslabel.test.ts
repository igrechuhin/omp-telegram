import { expect, test } from "bun:test";
import { userLink } from "../src/tg";

// `/status` used to print raw numeric ids, which name nobody and are not tappable. These pin the
// rendering of `getChat`'s reply, including the shapes Telegram returns for users who have hidden
// or never set a username.

test("a username renders as a t.me link anyone can open", () => {
  expect(userLink(7, { id: 7, username: "iv_an", first_name: "Ivan" })).toBe(
    '<a href="https://t.me/iv_an">@iv_an</a>',
  );
});

test("no username falls back to a tg:// deep link labelled by display name", () => {
  expect(userLink(8, { id: 8, first_name: "No", last_name: "Handle" })).toBe(
    '<a href="tg://user?id=8">No Handle</a>',
  );
});

test("with neither username nor name the link is labelled by id, never blank", () => {
  expect(userLink(9, { id: 9 })).toBe('<a href="tg://user?id=9">9</a>');
});

test("a non-object reply degrades to the id link instead of interpolating undefined", () => {
  for (const bad of [undefined, null, "nope", 42, []]) {
    expect(userLink(10, bad)).toBe('<a href="tg://user?id=10">10</a>');
  }
});

test("names and usernames are escaped for HTML parse mode", () => {
  // An unescaped `<` would break Telegram's parser and drop the whole status message.
  expect(userLink(11, { id: 11, first_name: "A<b>&c" })).toBe(
    '<a href="tg://user?id=11">A&lt;b&gt;&amp;c</a>',
  );
  expect(userLink(12, { id: 12, username: "a<b" })).toBe(
    '<a href="https://t.me/a%3Cb">@a&lt;b</a>',
  );
});

test("the terminal path's tag strip leaves readable plain-text names", () => {
  const line = `👤 allowed users: ${[
    userLink(7, { id: 7, username: "iv_an" }),
    userLink(8, { id: 8, first_name: "No", last_name: "Handle" }),
  ].join(", ")}`;
  expect(line.replace(/<[^>]+>/g, "")).toBe("👤 allowed users: @iv_an, No Handle");
});

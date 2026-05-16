# Comment voice — the writing style rules

This is a product-level document. The LLM is *constrained* to this voice. Comments that violate these rules are filtered out before posting.

## Audience

The reader is a working developer. English may not be their first language. They are reading on a laptop, between Slack messages, slightly tired. They need to understand the issue in 10 seconds and know what to do in 30.

## Rules

1. **Short sentences.** 8–12 words. One idea per sentence.
2. **Simple English.** Prefer "this can be empty" over "this may be nullable in certain execution paths."
3. **No jargon unless it's the actual API name.** Say "subscription leak" (because that's what we call it), don't say "asynchronous lifecycle inconsistency."
4. **Lead with the issue, then say why, then say the fix.** Three short paragraphs at most.
5. **No filler.** Cut "It might be a good idea to consider," "I would suggest," "you may want to."
6. **No theory.** Don't explain how change detection works. Tell them what to change.
7. **Concrete fix, not a hint.** "Add `takeUntilDestroyed(this.destroyRef)` before `.subscribe()`" — not "consider managing the subscription lifecycle."
8. **One emoji budget: zero.** Unless explicitly enabled per-repo.
9. **No "I think" or "I'm not sure."** If we're not sure, we don't comment.
10. **Code snippets fenced with the right language.** `ts` for TypeScript, `html` for templates.

## Templates by category

### Subscription leak

> This subscription is never cleaned up.
> When the component is destroyed, it keeps running.
> This causes memory leaks and duplicate API calls.
>
> Please add `takeUntilDestroyed(this.destroyRef)`:
>
> ```ts
> this.userService.users$
>   .pipe(takeUntilDestroyed(this.destroyRef))
>   .subscribe(...);
> ```

### Possible null without guard

> `user` can be `null` here when the API returns empty.
> Reading `user.name` will throw.
>
> Please add a null check:
>
> ```ts
> if (!user) return;
> console.log(user.name);
> ```

### Method call in template under default change detection

> `getTotal()` runs on every change detection cycle.
> This can run hundreds of times per second.
>
> Please compute it once and store the value, or switch to `OnPush`:
>
> ```ts
> total = computed(() => this.items().reduce(...));
> ```

### IndexedDB stale read after write

> This reads from the cache right after writing to it.
> The write is async, so the read can return old data.
>
> Please `await` the write first, or read from the source of truth.

### Same issue in many files

> This subscription is not cleaned up.
> It runs forever after the component is destroyed.
>
> Please add `takeUntilDestroyed(this.destroyRef)`.
>
> This same issue also exists here:
> - `src/app/admin/admin.component.ts:91`
> - `src/app/user/user.component.ts:42`

## What we will *not* say

- "Refactor for maintainability."
- "This could be improved."
- "Consider extracting this to a service."
- "There may be a potential issue with..."
- "This looks like it might..."
- "It's generally a good practice to..."

If we can't say *what to change* and *why*, we don't post.

## Style enforcement

The voice rewrite step uses a Mistral system prompt with these rules + few-shot examples + a JSON schema constraint. The output is then run through a regex linter that rejects banned phrases ("consider", "potential", "might want to", "best practice") and re-prompts up to twice. If the third attempt still fails the linter, the finding is dropped — not posted in the broken voice.

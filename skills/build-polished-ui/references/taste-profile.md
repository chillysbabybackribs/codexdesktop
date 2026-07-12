# Taste Profile Contract

Taste profiles are optional and must be confirmed by the user before they are persisted or applied beyond the current task.

Recommended workspace location: `.codex/ui-taste.json`.

```json
{
  "version": 1,
  "scope": "workspace",
  "confirmedByUser": true,
  "likes": ["editorial typography", "photography-first composition"],
  "dislikes": ["generic SaaS cards", "indiscriminate gradients"],
  "dimensions": {
    "density": "expressive",
    "contrast": "high",
    "shape": "architectural",
    "imagery": "environmental photography",
    "motion": "restrained",
    "voice": "specific and concise"
  },
  "referenceExampleIds": ["coffee-editorial-light"],
  "notes": "Do not turn these preferences into a universal house style."
}
```

Use the profile to rank directions, not to bypass the product brief. A healthcare portal and a neighborhood cafe should not converge on the same visual system merely because the same user requested them.

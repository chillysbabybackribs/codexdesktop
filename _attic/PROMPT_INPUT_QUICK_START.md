# Prompt Input - Quick Start Guide

## 🚀 Get Started in 2 Minutes

### Step 1: Import (add to your component file)
```tsx
import { PromptInput } from '@/components/ui';
import '@/components/ui/prompt-input.css';
```

### Step 2: Use it
```tsx
<PromptInput
  placeholder="Type your message..."
  onSubmit={async (message, attachments) => {
    console.log('User sent:', message, attachments);
    // Send to your API here
  }}
/>
```

Done! 🎉

---

## 📁 Where Are The Files?

```
✅ Component:     src/components/ui/prompt-input.tsx
✅ Styles:        src/components/ui/prompt-input.css
✅ Example:       src/components/PromptInputExample.tsx
✅ Docs:          PROMPT_INPUT_DOCS.md
✅ This guide:    PROMPT_INPUT_QUICK_START.md
```

---

## 🎯 Common Use Cases

### Use Case 1: Simple message input
```tsx
<PromptInput
  placeholder="Send a message..."
  onSubmit={(message) => {
    api.sendMessage(message);
  }}
/>
```

### Use Case 2: With loading state
```tsx
const [isLoading, setIsLoading] = useState(false);

const handleSubmit = async (message: string) => {
  setIsLoading(true);
  try {
    await api.sendMessage(message);
  } finally {
    setIsLoading(false);
  }
};

<PromptInput
  onSubmit={handleSubmit}
  disabled={isLoading}
  isLoading={isLoading}
/>
```

### Use Case 3: With file attachments
```tsx
const handleSubmit = async (message: string, files?: File[]) => {
  const formData = new FormData();
  formData.append('message', message);
  
  if (files) {
    files.forEach(f => formData.append('files', f));
  }
  
  await fetch('/api/messages', {
    method: 'POST',
    body: formData
  });
};

<PromptInput
  onSubmit={handleSubmit}
  allowAttachments={true}
/>
```

### Use Case 4: Replace existing textarea
**Before:**
```tsx
<textarea
  value={input}
  onChange={(e) => setInput(e.target.value)}
  onKeyDown={(e) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      handleSend(input);
      setInput('');
    }
  }}
/>
<button onClick={() => handleSend(input)}>Send</button>
```

**After:**
```tsx
<PromptInput
  onSubmit={handleSend}
/>
```

---

## 🎨 Customization

### Change colors
```css
/* In your CSS file */
:root {
  --primary: #10b981;              /* Green buttons */
  --text-primary: #000;             /* Black text */
  --bg-secondary: #f5f5f5;          /* Light gray bg */
}
```

### Change placeholder
```tsx
<PromptInput
  placeholder="What's on your mind?"
  onSubmit={handleSubmit}
/>
```

### Limit message length
```tsx
<PromptInput
  maxLength={500}
  onSubmit={handleSubmit}
/>
```

### Disable attachments
```tsx
<PromptInput
  allowAttachments={false}
  onSubmit={handleSubmit}
/>
```

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl/Cmd + Enter | Send message |
| Enter | New line |
| Tab | Focus next button |

---

## 🧪 Test It

```tsx
// Add to any component to test
import { PromptInputExample } from '@/components/PromptInputExample';
import '@/components/PromptInputExample.css';

export function TestPage() {
  return <PromptInputExample />;
}
```

---

## 📝 Props Cheatsheet

```typescript
<PromptInput
  placeholder="Type here"              // Text input placeholder
  onSubmit={handleSubmit}              // Required: called on send
  disabled={false}                     // Disable input
  isLoading={false}                    // Show loading state
  maxLength={4096}                     // Character limit
  allowAttachments={true}              // Enable file uploads
  className="custom-class"             // CSS class
/>
```

---

## 🐛 Common Issues

**Q: Styles don't show**  
A: Import the CSS file: `import '@/components/ui/prompt-input.css';`

**Q: File upload not working**  
A: Check `allowAttachments={true}`

**Q: Keyboard shortcuts not working**  
A: Check browser console for JS errors

**Q: Component too wide/narrow**  
A: Set width on parent container

---

## 🔗 Where to Integrate

### Option 1: Chat message input
```tsx
// src/renderer/src/ChatPane.tsx or similar
import { PromptInput } from '@/components/ui';

// Replace existing textarea with:
<PromptInput onSubmit={handleSendMessage} />
```

### Option 2: Compose area
```tsx
// src/renderer/src/ChatControls.tsx or similar
<PromptInput
  placeholder="Send a reply..."
  onSubmit={onSend}
/>
```

### Option 3: New component
```tsx
// Create new file: src/components/ChatMessageInput.tsx
export function ChatMessageInput() {
  return (
    <PromptInput
      onSubmit={(msg) => sendToThread(msg)}
    />
  );
}
```

---

## 💡 Tips

1. **Always import CSS** for styling to work
2. **Use async/await** in onSubmit for API calls
3. **Show loading state** during API calls
4. **Customize colors** with CSS custom properties
5. **Test keyboard** shortcuts with Ctrl+Enter
6. **Handle attachments** in FormData for uploads

---

## 📚 More Info

- Full docs: `PROMPT_INPUT_DOCS.md`
- Installation: `INSTALLATION_SUMMARY.md`
- Example code: `src/components/PromptInputExample.tsx`

---

**Questions?** Check `PROMPT_INPUT_DOCS.md` for detailed documentation.

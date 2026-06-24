import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { Button } from './ui/button'
import { Tooltip } from './ui/tooltip'

interface Props {
  text: string
  label?: string
}

export function CopyButton({ text, label = 'Copy' }: Props) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Tooltip content={copied ? 'Copied!' : label} side="bottom">
      <Button variant="ghost" size="icon" onClick={copy} aria-label={label}>
        {copied ? (
          <Check className="h-3.5 w-3.5 text-foreground" />
        ) : (
          <Copy className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </Button>
    </Tooltip>
  )
}

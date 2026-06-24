import { useState } from 'react'
import { Button } from '@tremor/react'

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
    <Button size="xs" variant="secondary" onClick={copy}>
      {copied ? '✓ Copied' : label}
    </Button>
  )
}

import { useTheme } from 'next-themes'
import { Sun, Moon } from 'lucide-react'
import { Button } from './ui/button'
import { Tooltip } from './ui/tooltip'

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()

  const toggle = () => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')

  return (
    <Tooltip content={resolvedTheme === 'dark' ? 'Light mode' : 'Dark mode'} side="bottom">
      <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">
        <Sun className="h-4 w-4 rotate-0 scale-100 transition-transform dark:-rotate-90 dark:scale-0" />
        <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-transform dark:rotate-0 dark:scale-100" />
      </Button>
    </Tooltip>
  )
}

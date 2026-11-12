import type { Metadata } from 'next'
import { Instrument_Sans, Newsreader } from 'next/font/google'
import './globals.css'

const instrument = Instrument_Sans({
  subsets: ['latin'],
  variable: '--font-instrument',
  display: 'swap',
})

const newsreader = Newsreader({
  subsets: ['latin'],
  variable: '--font-newsreader',
  display: 'swap',
  style: ['normal'],
})

export const metadata: Metadata = {
  title: 'ClaimKit',
  description:
    'A shared workspace where a family puts together one complete health-insurance reimbursement claim.',
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${instrument.variable} ${newsreader.variable}`}>
      <body>{children}</body>
    </html>
  )
}

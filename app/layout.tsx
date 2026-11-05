import './globals.css';
import { IBM_Plex_Sans_Thai } from 'next/font/google';
import Galaxy from '@/components/Galaxy';

const font = IBM_Plex_Sans_Thai({ subsets: ['thai', 'latin'], weight: ['400', '500', '600', '700'], display: 'swap' });
export const metadata = { title: 'MT5 Signal Hub' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: "try{document.documentElement.dataset.theme=localStorage.getItem('theme')||'dark'}catch(e){}" }} /></head>
      <body className={font.className}>
        <Galaxy />
        {children}
      </body>
    </html>
  );
}

import { Html, Head, Main, NextScript } from 'next/document'

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <script src="https://cdn.tailwindcss.com"></script>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              tailwind.config = {
                theme: {
                  extend: {
                    colors: {
                      brand: {
                        dark: '#0f172a',
                        navy: '#1e293b',
                      }
                    }
                  }
                }
              }
            `,
          }}
        />
      </Head>
      <body className="bg-[#111827] text-gray-100">
        <Main />
        <NextScript />
      </body>
    </Html>
  )
}

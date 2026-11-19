import { Stack, Text } from '@chakra-ui/react'

const linkStyle = { color: '#00a8fc', textDecoration: 'underline' } as const

/** The ordered Discord Developer Portal steps. Shared by the setup screen and the Settings guide. */
export function SetupSteps() {
  return (
    <Stack as="ol" gap={3} ps={5} fontSize="sm" color="fg.muted" listStyleType="decimal">
      <li>
        <Text as="span" color="fg">
          Open the{' '}
          <a
            href="https://discord.com/developers/applications"
            target="_blank"
            rel="noopener noreferrer"
            style={linkStyle}
          >
            Discord Developer Portal
          </a>
          , then create or select an application.
        </Text>{' '}
        Copy its Application ID into the Client ID field.
      </li>
      <li>
        <Text as="span" color="fg">
          Enable the Social SDK for your application.
        </Text>{' '}
        The setting is in the application's settings in the portal.
      </li>
      <li>
        <Text as="span" color="fg">
          Under OAuth2, turn on Public Client.
        </Text>{' '}
        Public Client uses PKCE, so leave Client secret blank. Enter a secret only if your
        application requires one.
      </li>
      <li>
        <Text as="span" color="fg">
          Add the Callback URL from the form as a redirect.
        </Text>{' '}
        Discord's acceptance of <code>chrome-extension://</code> redirects is not verified. If it
        rejects the URL, sign-in cannot complete.
      </li>
      <li>
        <Text as="span" color="fg">
          Save settings, then sign in with Discord.
        </Text>{' '}
        The extension requests the <code>openid</code> and <code>sdk.social_layer_presence</code>{' '}
        scopes.
      </li>
    </Stack>
  )
}

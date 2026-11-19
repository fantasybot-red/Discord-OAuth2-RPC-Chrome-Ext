import { useState } from 'react'
import type { FormEvent } from 'react'
import {
  Badge,
  Box,
  Button,
  createListCollection,
  Flex,
  Grid,
  IconButton,
  Input,
  Portal,
  Select,
  Separator,
  Stack,
  Text,
} from '@chakra-ui/react'
import type { Activity, ActivityButton, ActivityType } from '@/shared/types'
import { TEMPLATE_PARAMETERS } from '@/lib/templates'
import { ChevronDownIcon, ChevronUpIcon, Spinner, TrashIcon } from '../icons'

interface ActivitySectionProps {
  activity: Activity
  activityEnabled: boolean
  allowUrlSharing?: boolean
  onChange: (activity: Activity) => void
  onApply: (activity: Activity) => Promise<void>
  isApplying: boolean
}

const ACTIVITY_TYPE_COLLECTION = createListCollection({
  items: [
    { label: 'Playing', value: '0' },
    { label: 'Listening', value: '2' },
    { label: 'Watching', value: '3' },
    { label: 'Competing', value: '5' },
  ],
})

export function ActivitySection({
  activity,
  activityEnabled,
  allowUrlSharing = false,
  onChange,
  onApply,
  isApplying,
}: ActivitySectionProps) {
  const [showAssets, setShowAssets] = useState(
    Boolean(activity.largeImage || activity.largeText || activity.smallImage || activity.smallText),
  )
  const [showPlaceholders, setShowPlaceholders] = useState(false)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const handleTypeChange = (details: { value: string[] }) => {
    const raw = Number(details.value[0]) as ActivityType
    if (raw === 0 || raw === 2 || raw === 3 || raw === 5) {
      onChange({ ...activity, type: raw })
    }
  }

  const handleFieldChange = (field: keyof Activity, val: string) => {
    onChange({ ...activity, [field]: val })
  }

  const handleTimestampChange = (field: 'start' | 'end', val: string) => {
    const existing = activity.timestamps || { start: '', end: '' }
    onChange({
      ...activity,
      timestamps: {
        ...existing,
        [field]: val,
      },
    })
  }

  const handleAddButton = () => {
    const existing = activity.buttons || []
    if (existing.length >= 2) return
    const updated = [...existing, { label: '', url: '' }]
    onChange({ ...activity, buttons: updated })
  }

  const handleRemoveButton = (index: number) => {
    const existing = activity.buttons || []
    const updated = existing.filter((_, i) => i !== index)
    onChange({ ...activity, buttons: updated })
  }

  const handleButtonChange = (index: number, field: keyof ActivityButton, val: string) => {
    const existing = activity.buttons || []
    const updated = existing.map((btn, i) => (i === index ? { ...btn, [field]: val } : btn))
    onChange({ ...activity, buttons: updated })
  }

  const handleCopyParam = async (param: string) => {
    try {
      await navigator.clipboard.writeText(param)
      setCopiedKey(param)
      setTimeout(() => setCopiedKey(null), 1500)
    } catch {
      // fallback
    }
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    onApply(activity)
  }

  const buttons = activity.buttons || []
  const hasUrlSharingWarning = buttons.some((b) => b.url?.includes('{tab_url}')) && !allowUrlSharing

  return (
    <Box w="100%">
      <Flex align="center" justify="space-between" mb={3}>
        <Text fontSize="md" fontWeight="600" color="fg">
          Activity template
        </Text>
        {activityEnabled && (
          <Badge colorPalette="green" variant="subtle" size="sm">
            Saved
          </Badge>
        )}
      </Flex>

      <form onSubmit={handleSubmit}>
        <Stack gap={4}>
          {/* Type & App Name */}
          <Grid templateColumns={{ base: '1fr', sm: '130px 1fr' }} gap={3} alignItems="start">
            <Box>
              {/* Select.Root is a flex column with its own gap. gap=0 plus the same
                  label metrics as .ui-label puts the trigger on the input's baseline. */}
              <Select.Root
                collection={ACTIVITY_TYPE_COLLECTION}
                value={[String(activity.type)]}
                onValueChange={handleTypeChange}
                size="sm"
                positioning={{ sameWidth: true }}
                gap="0"
              >
                <Select.HiddenSelect />
                <Select.Label
                  className="ui-label"
                  fontSize="13px"
                  fontWeight="600"
                  lineHeight="1.5"
                  mb="5px"
                  color="inherit"
                >
                  Type
                </Select.Label>
                <Select.Control>
                  <Select.Trigger>
                    <Select.ValueText placeholder="Select type" />
                  </Select.Trigger>
                  <Select.IndicatorGroup>
                    <Select.Indicator />
                  </Select.IndicatorGroup>
                </Select.Control>
                <Portal>
                  <Select.Positioner>
                    <Select.Content bg="bg.panel" borderColor="border.subtle" zIndex="max">
                      {ACTIVITY_TYPE_COLLECTION.items.map((item) => (
                        <Select.Item item={item} key={item.value}>
                          <Select.ItemText>{item.label}</Select.ItemText>
                          <Select.ItemIndicator />
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Positioner>
                </Portal>
              </Select.Root>
            </Box>

            <Box>
              <label htmlFor="activity-name-input" className="ui-label">
                Application name
              </label>
              <Input
                id="activity-name-input"
                size="sm"
                placeholder="e.g. {tab_title}"
                value={activity.name}
                onChange={(e) => handleFieldChange('name', e.target.value)}
                required
              />
            </Box>
          </Grid>

          {/* Details */}
          <Box>
            <label htmlFor="activity-details-input" className="ui-label">
              Details
            </label>
            <Input
              id="activity-details-input"
              size="sm"
              placeholder="e.g. Reading on {tab_hostname}"
              value={activity.details}
              onChange={(e) => handleFieldChange('details', e.target.value)}
            />
          </Box>

          {/* State */}
          <Box>
            <label htmlFor="activity-state-input" className="ui-label">
              State
            </label>
            <Input
              id="activity-state-input"
              size="sm"
              placeholder="e.g. {tab_count} tabs open"
              value={activity.state}
              onChange={(e) => handleFieldChange('state', e.target.value)}
            />
          </Box>

          <Separator borderColor="border.subtle" />

          {/* Timestamps */}
          <Box>
            <Text fontSize="sm" fontWeight="600" color="fg" mb={1}>
              Timestamps
            </Text>
            <Text fontSize="xs" color="fg.muted" mb={2.5}>
              Accepts {'{browser_started_at}'}, {'{tab_opened_at}'}, {'{tab_active_at}'}, epoch milliseconds, or ISO 8601 with timezone. Blank start hides the timer.
            </Text>
            <Grid templateColumns={{ base: '1fr', sm: '1fr 1fr' }} gap={3}>
              <Box>
                <label htmlFor="activity-start-timestamp-input" className="ui-label">
                  Start timestamp
                </label>
                <Input
                  id="activity-start-timestamp-input"
                  size="sm"
                  placeholder="e.g. {tab_opened_at} or ISO/epoch"
                  value={activity.timestamps?.start || ''}
                  onChange={(e) => handleTimestampChange('start', e.target.value)}
                />
              </Box>
              <Box>
                <label htmlFor="activity-end-timestamp-input" className="ui-label">
                  End timestamp (optional)
                </label>
                <Input
                  id="activity-end-timestamp-input"
                  size="sm"
                  placeholder="e.g. 2026-11-20T12:00:00Z"
                  value={activity.timestamps?.end || ''}
                  onChange={(e) => handleTimestampChange('end', e.target.value)}
                />
              </Box>
            </Grid>
          </Box>

          <Separator borderColor="border.subtle" />

          {/* Collapsible Placeholders Reference */}
          <Box>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              p={0}
              color="fg.muted"
              onClick={() => setShowPlaceholders(!showPlaceholders)}
            >
              {showPlaceholders ? <ChevronUpIcon size={13} /> : <ChevronDownIcon size={13} />}
              <span>Template placeholders</span>
            </Button>

            {showPlaceholders && (
              <Box mt={2}>
                <Text fontSize="2xs" color="fg.muted" mb={1.5}>
                  Click placeholder to copy to clipboard:
                </Text>
                <Flex wrap="wrap" gap={1}>
                  {TEMPLATE_PARAMETERS.map((p) => {
                    const token = `{${p.key}}`
                    return (
                      <Button
                        key={p.key}
                        type="button"
                        size="2xs"
                        variant="surface"
                        colorPalette={copiedKey === token ? 'green' : 'gray'}
                        onClick={() => handleCopyParam(token)}
                        fontFamily="mono"
                        fontSize="2xs"
                        title={p.description || p.label || 'Click to copy placeholder'}
                      >
                        {copiedKey === token ? 'Copied' : token}
                      </Button>
                    )
                  })}
                </Flex>
              </Box>
            )}
          </Box>

          {/* Collapsible Image Assets */}
          <Box>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              p={0}
              color="fg.muted"
              onClick={() => setShowAssets(!showAssets)}
            >
              {showAssets ? <ChevronUpIcon size={13} /> : <ChevronDownIcon size={13} />}
              <span>Image assets (optional)</span>
            </Button>

            {showAssets && (
              <Stack gap={3} pt={2}>
                <Grid templateColumns={{ base: '1fr', sm: '1fr 1fr' }} gap={3}>
                  <Box>
                    <label htmlFor="activity-large-image-input" className="ui-label">
                      Large image
                    </label>
                    <Input
                      id="activity-large-image-input"
                      size="sm"
                      placeholder="Key or {tab_favicon}"
                      value={activity.largeImage}
                      onChange={(e) => handleFieldChange('largeImage', e.target.value)}
                    />
                  </Box>
                  <Box>
                    <label htmlFor="activity-large-text-input" className="ui-label">
                      Large hover text
                    </label>
                    <Input
                      id="activity-large-text-input"
                      size="sm"
                      placeholder="Tooltip text"
                      value={activity.largeText}
                      onChange={(e) => handleFieldChange('largeText', e.target.value)}
                    />
                  </Box>
                </Grid>

                <Grid templateColumns={{ base: '1fr', sm: '1fr 1fr' }} gap={3}>
                  <Box>
                    <label htmlFor="activity-small-image-input" className="ui-label">
                      Small image
                    </label>
                    <Input
                      id="activity-small-image-input"
                      size="sm"
                      placeholder="Key or URL"
                      value={activity.smallImage}
                      onChange={(e) => handleFieldChange('smallImage', e.target.value)}
                    />
                  </Box>
                  <Box>
                    <label htmlFor="activity-small-text-input" className="ui-label">
                      Small hover text
                    </label>
                    <Input
                      id="activity-small-text-input"
                      size="sm"
                      placeholder="Tooltip text"
                      value={activity.smallText}
                      onChange={(e) => handleFieldChange('smallText', e.target.value)}
                    />
                  </Box>
                </Grid>

                <Text fontSize="2xs" color="fg.muted" lineHeight="1.4">
                  Site icon services (Google S2, Icon Horse) receive the hostname, not the page URL.
                </Text>
              </Stack>
            )}
          </Box>

          <Separator borderColor="border.subtle" />

          {/* Discord Link Buttons (Max 2) */}
          <Box>
            <Flex align="center" justify="space-between" mb={2}>
              <Text fontSize="sm" fontWeight="600" color="fg">
                Discord link buttons ({buttons.length}/2)
              </Text>
              {buttons.length < 2 && (
                <Button
                  type="button"
                  size="xs"
                  variant="subtle"
                  onClick={handleAddButton}
                >
                  Add button
                </Button>
              )}
            </Flex>

            {hasUrlSharingWarning && (
              <Box p={2.5} mb={2.5} borderRadius="md" bg="bg.warning" borderWidth="1px" borderColor="border.warning">
                <Text fontSize="xs" color="fg.warning" lineHeight="1.4">
                  Enable full URL sharing in Settings to show this button, or use a fixed URL.
                </Text>
              </Box>
            )}

            {buttons.length === 0 ? (
              <Text fontSize="xs" color="fg.muted">
                No link buttons added. Up to 2 buttons supported.
              </Text>
            ) : (
              <Stack gap={3}>
                {buttons.map((btn, index) => (
                  <Box key={index} py={1}>
                    <Flex justify="space-between" align="center" mb={1.5}>
                      <Text fontSize="xs" fontWeight="600" color="fg">
                        Button {index + 1}
                      </Text>
                      <IconButton
                        type="button"
                        size="xs"
                        variant="ghost"
                        colorPalette="red"
                        onClick={() => handleRemoveButton(index)}
                        aria-label={`Remove button ${index + 1}`}
                      >
                        <TrashIcon size={12} />
                      </IconButton>
                    </Flex>
                    <Grid templateColumns={{ base: '1fr', sm: '1fr 2fr' }} gap={2}>
                      <Box>
                        <label htmlFor={`button-${index}-label-input`} className="ui-label">
                          Label
                        </label>
                        <Input
                          id={`button-${index}-label-input`}
                          size="sm"
                          placeholder="Button label"
                          value={btn.label}
                          maxLength={32}
                          onChange={(e) => handleButtonChange(index, 'label', e.target.value)}
                        />
                      </Box>
                      <Box>
                        <label htmlFor={`button-${index}-url-input`} className="ui-label">
                          URL
                        </label>
                        <Input
                          id={`button-${index}-url-input`}
                          size="sm"
                          placeholder="https://... or {tab_url}"
                          value={btn.url}
                          maxLength={2048}
                          onChange={(e) => handleButtonChange(index, 'url', e.target.value)}
                        />
                      </Box>
                    </Grid>
                  </Box>
                ))}
              </Stack>
            )}
          </Box>

          <Separator borderColor="border.subtle" />

          {/* Action Buttons */}
          <Button
            type="submit"
            size="sm"
            colorPalette="blue"
            w="100%"
            mt={1}
            disabled={isApplying || !activity.name.trim()}
          >
            {isApplying && <Spinner size={14} />}
            <span>Save activity</span>
          </Button>
        </Stack>
      </form>
    </Box>
  )
}

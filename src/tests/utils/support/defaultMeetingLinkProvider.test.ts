import { describe, expect, it } from 'vitest';
import {
  inferSupportMeetingLinkProvider,
  normalizeDefaultSupportMeetingLink,
} from '../../../utils/support/meetingLink';

describe('default support meeting link normalization', () => {
  it('infers zoom / teams / other from the host only', () => {
    expect(inferSupportMeetingLinkProvider('https://zoom.us/j/1')).toBe('zoom');
    expect(inferSupportMeetingLinkProvider('https://us02web.zoom.us/my/room')).toBe('zoom');
    expect(inferSupportMeetingLinkProvider('https://teams.microsoft.com/l/meetup-join/x')).toBe('teams');
    expect(inferSupportMeetingLinkProvider('https://teams.live.com/meet/123')).toBe('teams');
    expect(inferSupportMeetingLinkProvider('https://meet.google.com/abc')).toBe('other');
    // Look-alike hosts are not trusted as a provider label.
    expect(inferSupportMeetingLinkProvider('https://zoom.us.evil.example/j/1')).toBe('other');
    expect(inferSupportMeetingLinkProvider('https://evil.example/zoom.us')).toBe('other');
    expect(inferSupportMeetingLinkProvider('not a url')).toBe('other');
  });

  it('clears on blank input and validates everything else as https', () => {
    expect(normalizeDefaultSupportMeetingLink(null)).toBeNull();
    expect(normalizeDefaultSupportMeetingLink(undefined)).toBeNull();
    expect(normalizeDefaultSupportMeetingLink('   ')).toBeNull();
    expect(normalizeDefaultSupportMeetingLink(' https://zoom.us/j/1 ')).toEqual({
      url: 'https://zoom.us/j/1',
      provider: 'zoom',
    });
    expect(() => normalizeDefaultSupportMeetingLink('http://zoom.us/j/1')).toThrow(/https/);
    expect(() => normalizeDefaultSupportMeetingLink('ftp://zoom.us/j/1')).toThrow(/https/);
    expect(() => normalizeDefaultSupportMeetingLink({})).toThrow(/valid meeting link/);
  });
});

package com.deardiary.app;

import static org.junit.Assert.*;

import org.junit.Test;

public class ExampleUnitTest {

    @Test
    public void backupScheduleAcceptsValidTime() {
        assertArrayEquals(new int[] { 0, 0 }, DriveBackupScheduler.parseHourMinute("00:00"));
        assertArrayEquals(new int[] { 23, 59 }, DriveBackupScheduler.parseHourMinute("23:59"));
    }

    @Test
    public void backupScheduleFallsBackForInvalidTime() {
        assertArrayEquals(new int[] { 2, 0 }, DriveBackupScheduler.parseHourMinute(null));
        assertArrayEquals(new int[] { 2, 0 }, DriveBackupScheduler.parseHourMinute("24:00"));
        assertArrayEquals(new int[] { 2, 0 }, DriveBackupScheduler.parseHourMinute("09:75"));
        assertArrayEquals(new int[] { 2, 0 }, DriveBackupScheduler.parseHourMinute("not-a-time"));
    }
}

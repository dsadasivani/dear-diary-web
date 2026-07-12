package com.deardiary.sync.device;

import java.util.UUID;

public record ActiveDevice(UUID accountId, UUID deviceId, String ownerSubject, int keyEpoch, long currentSequence) {}

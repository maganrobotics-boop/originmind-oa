"""Pure motion settings for isolated turtlesim; not a real robot controller."""
import math

LINEAR = 1.0
ANGULAR = 1.0
DURATION = 2 * math.pi


def command(elapsed):
    if 0 <= elapsed < DURATION:
        return LINEAR, ANGULAR
    return 0.0, 0.0


def expected():
    return {"duration_s": DURATION, "radius": abs(LINEAR / ANGULAR), "distance": abs(LINEAR) * DURATION}
